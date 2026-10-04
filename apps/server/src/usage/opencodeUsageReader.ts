// A worker thread reads the live OpenCode databases (node:sqlite); Node fs walks legacy JSON history.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import { OPENCODE_ROWS_WORKER_SOURCE, type OpenCodeRowsResult } from "./opencodeRowsWorker.ts";
import { makeSliceYield } from "./sliceYield.ts";
import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The message fields usage needs; everything else in a row's JSON is skipped. */
const MESSAGE_FIELDS = [
  "role",
  "model",
  "modelID",
  "tokens",
  "time",
  "cost",
  "sessionID",
  "id",
] as const;

/**
 * SQL that hands back only {@link MESSAGE_FIELDS}, as a JSON array in that
 * order, instead of the row's whole `data`. A message row can carry megabytes
 * of tool output (the largest in the live store is 12 MB): fetching and
 * parsing that in JavaScript held the event loop for about 100 ms, while
 * SQLite skims past it inside one step. `json_valid` first, so a damaged row
 * reads as no fields (skipped, as before) instead of failing the whole table.
 */
const MESSAGE_FIELDS_SQL = `CASE WHEN json_valid(data) THEN json_extract(data, ${MESSAGE_FIELDS.map((field) => `'$.${field}'`).join(", ")}) END`;

/**
 * `message` rows longer than this are skipped without being read. Message rows
 * hold a role, a model and token counts, a few KB; the exceptions are user
 * messages that carry file diffs (the six largest in the live store are 1.1 to
 * 12.5 MB, all role user, and reading one costs about 100 ms of event loop
 * when its pages are not cached). Token usage lives on assistant rows.
 */
const MAX_MESSAGE_ROW_CHARS = 2_000_000;

/** The projection back as a message object: absent fields stay absent. */
function messageFromFields(fields: string): Record<string, unknown> | null {
  let values: unknown;
  try {
    values = JSON.parse(fields);
  } catch {
    return null;
  }
  if (!Array.isArray(values)) return null;
  const message: Record<string, unknown> = {};
  MESSAGE_FIELDS.forEach((field, index) => {
    const value: unknown = values[index];
    if (value !== null && value !== undefined) message[field] = value;
  });
  return message;
}

/** OpenCode stores uncached input and reasoning separately from input/output. */
function parseOpenCodeMessage(
  source: string,
  fallback: {
    readonly id?: string;
    readonly sessionId?: string;
    readonly timestampMs?: number;
  } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  return parseOpenCodeMessageObject(object(parsed), fallback);
}

function parseOpenCodeMessageObject(
  message: Record<string, unknown>,
  fallback: {
    readonly id?: string;
    readonly sessionId?: string;
    readonly timestampMs?: number;
  },
): UsageRecord | null {
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  const modelReference = object(message.model);
  const model = text(modelReference.id) || text(modelReference.modelID) || text(message.modelID);
  const timestampMs = object(message.time).created ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokens(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokens(usage.input),
    cachedInputTokens: tokens(cache.read),
    cacheCreationTokens: tokens(cache.write),
    outputTokens: tokens(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message.id);
  const cost = message.cost;
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    // OpenCode writes zero for models without a known rate, including paid
    // subscription models. Let the shared price table estimate those records.
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    fast: false,
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

/** The worker gets this long to read every database before it is given up on. */
const WORKER_TIMEOUT_MS = 120_000;

/**
 * The databases' message rows, fetched on a worker thread (see
 * `opencodeRowsWorker.ts`). Null when the worker failed or timed out, which the
 * caller reports as a partial source.
 */
function readRowsInWorker(
  root: string,
  names: ReadonlyArray<string>,
  sinceMs: number,
): Promise<ReadonlyArray<OpenCodeRowsResult> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new NodeWorkerThreads.Worker(OPENCODE_ROWS_WORKER_SOURCE, {
      eval: true,
      workerData: {
        root,
        names,
        sinceMs,
        fieldsSql: MESSAGE_FIELDS_SQL,
        maxRowChars: MAX_MESSAGE_ROW_CHARS,
      },
      // Rows are a few hundred bytes each; this only bounds a runaway.
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    const finish = (value: ReadonlyArray<OpenCodeRowsResult> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), WORKER_TIMEOUT_MS);
    worker.once("message", (value: ReadonlyArray<OpenCodeRowsResult>) => finish(value));
    worker.once("error", () => finish(null));
    worker.once("exit", () => finish(null));
  });
}

export interface OpenCodeUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

/** Reads current SQLite and pre-migration JSON stores without modifying either. */
export async function readOpenCodeUsage(
  root: string,
  sinceMs: number,
): Promise<OpenCodeUsageReadResult> {
  const files: { path: string; records: UsageRecord[] }[] = [];
  const seen = new Set<string>();
  // Message rows run to several KB of JSON each, so a fixed count of rows per
  // yield is not a bound on how long the loop holds the event loop; time is.
  const slice = makeSliceYield();
  let found = false;
  let error = false;
  const append = (records: UsageRecord[], record: UsageRecord | null) => {
    if (record === null || record.timestampMs < sinceMs) return;
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) return;
      seen.add(record.dedupeKey);
    }
    records.push(record);
  };

  let databases: string[] = [];
  try {
    databases = (await NodeFSP.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => (a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b)));
  } catch (cause) {
    if (object(cause).code !== "ENOENT") error = true;
  }
  const fetched = databases.length === 0 ? [] : await readRowsInWorker(root, databases, sinceMs);
  for (const name of databases) {
    found = true;
    const file = { path: NodePath.join(root, name), records: [] as UsageRecord[] };
    files.push(file);
    const result = fetched?.find((candidate) => candidate.name === name);
    if (result === undefined || result.error) error = true;
    for (const [id, sessionId, fields, created] of result?.rows ?? []) {
      const message = messageFromFields(text(fields));
      append(
        file.records,
        message === null
          ? null
          : parseOpenCodeMessageObject(message, {
              id: text(id),
              sessionId: text(sessionId),
              ...(typeof created === "number" ? { timestampMs: created } : {}),
            }),
      );
      if (slice.due()) await slice.yieldNow();
    }
  }

  // Do not follow symlinks, including cycles. Database records win over their
  // old JSON copies when OpenCode has migrated a store in place.
  const directories = [NodePath.join(root, "storage", "message")];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    try {
      for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        const path = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          directories.push(path);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          found = true;
          const id = entry.name.slice(0, -5);
          if (seen.has(`opencode:${id}`)) continue;
          const file = { path, records: [] as UsageRecord[] };
          files.push(file);
          try {
            append(
              file.records,
              parseOpenCodeMessage(await NodeFSP.readFile(path, "utf8"), { id }),
            );
          } catch (cause) {
            if (object(cause).code !== "ENOENT") error = true;
          }
        }
      }
    } catch (cause) {
      if (object(cause).code !== "ENOENT") error = true;
    }
  }
  return { files, missing: !found && !error, error };
}
