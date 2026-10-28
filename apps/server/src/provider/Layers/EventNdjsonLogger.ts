// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort provider event logging with one shared writer per thread.
 *
 * Native and canonical views share batching, rotation, and retention state so
 * they cannot race while appending to the same thread-scoped file.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { errorTag } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import { secretRedactor } from "../../personal/secrets/secretRedaction.ts";
import type { ResourceAttribution } from "../../resourceTelemetry/ResourceAttribution.ts";

const MEBIBYTE = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_BATCH_WINDOW_MS = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 512 * MEBIBYTE;
const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;
const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_BUFFERED_BYTES = MEBIBYTE;
const DEFAULT_MAX_BUFFERED_RECORDS = 512;
// Lines waiting behind a slow disk. Past this the oldest whole batches are dropped (these logs
// are best-effort; a server frozen behind a log file is worse than a gap in it).
const MAX_QUEUED_WRITE_BYTES = 32 * MEBIBYTE;
const MAX_RECORD_CHARACTERS = 64 * 1024;
const MAX_RECORD_FIELDS = 1_024;
const MAX_RECORD_DEPTH = 16;
const GLOBAL_THREAD_SEGMENT = "_global";
const LOG_SCOPE = "provider-observability";
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const transientCanonicalEventTypes = new Set([
  "content.delta",
  "hook.progress",
  "item.updated",
  "task.progress",
  "thread.realtime.audio.delta",
  "tool.progress",
  "turn.proposed.delta",
]);
const transientNativeMethods = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "turn/diff/updated",
]);
const transientAcpUpdates = new Set(["agent_message_chunk", "agent_thought_chunk"]);

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStore {
  readonly filePath: string;
  readonly logger: (stream: EventNdjsonStream) => EventNdjsonLogger;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStoreOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
  readonly retentionCheckIntervalMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedRecords?: number;
  readonly attribution?: ResourceAttribution["Service"];
}

export interface EventNdjsonLoggerOptions extends EventNdjsonLogStoreOptions {
  readonly stream: EventNdjsonStream;
}

export class EventNdjsonLogConfigurationError extends Schema.TaggedError<EventNdjsonLogConfigurationError>()(
  "EventNdjsonLogConfigurationError",
  {
    filePath: Schema.String,
    option: Schema.String,
    value: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider event log option '${this.option}' must be an integer >= ${this.minimum}; received ${this.value} for '${this.filePath}'`;
  }
}

export class EventNdjsonLogDirectoryError extends Schema.TaggedError<EventNdjsonLogDirectoryError>()(
  "EventNdjsonLogDirectoryError",
  {
    directory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create provider event log directory '${this.directory}'`;
  }
}

export type EventNdjsonLogStoreError =
  | EventNdjsonLogConfigurationError
  | EventNdjsonLogDirectoryError;

interface ResolvedOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly retentionCheckIntervalMs: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedRecords: number;
  readonly attribution: ResourceAttribution["Service"] | undefined;
}

export interface PendingRecord {
  readonly stream: EventNdjsonStream;
  readonly threadSegment: string;
  readonly line: string;
  readonly bytes: number;
}

interface StoreState {
  readonly pending: Array<PendingRecord>;
  readonly pendingBytes: number;
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly flushScheduled: boolean;
  readonly closed: boolean;
  readonly lastRetentionAt: number;
}

interface AttributionSummary {
  readonly stream: EventNdjsonStream;
  readonly count: number;
  readonly logicalWriteBytes: number;
}

interface FileOperationFailure {
  readonly filePath: string;
  readonly cause: unknown;
}

interface RetentionResult {
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

interface DrainResult {
  readonly attributions: ReadonlyArray<AttributionSummary>;
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

/**
 * Read once per store (so at server start). `off` restores the synchronous append on the event
 * loop: 19-21 Oct, 27 stalls (94.5 s, up to 9.5 s) were the server waiting in appendFileSync on
 * an `events.<thread>.log` while the disk was busy.
 */
export const providerLogAsyncEnabled = (value: string | undefined): boolean =>
  !["off", "0", "false", "no", "disabled"].includes(value?.trim().toLowerCase() ?? "");

interface BackgroundWriter {
  readonly enqueue: (sink: RotatingFileSink, filePath: string, text: string | Buffer) => void;
  readonly isBroken: (sink: RotatingFileSink) => boolean;
  /** Failures and dropped lines since the last call. */
  readonly takeReport: () => {
    readonly failures: ReadonlyArray<FileOperationFailure>;
    readonly droppedRecords: number;
    readonly droppedBytes: number;
  };
  /** Waits until every queued append has landed or failed. */
  readonly drain: () => Promise<void>;
}

/**
 * Appends provider log batches off the event loop, the trace sink's pattern: one write in flight
 * per store, so lines land in the order they were drained and a file is never rotated under an
 * append. Only the append is asynchronous; a rotation (rare, renames only) stays synchronous.
 * A failed append drops that sink, and its later queued batches, exactly as a throwing
 * synchronous write did; the next drain opens a fresh sink.
 */
function makeBackgroundWriter(): BackgroundWriter {
  const queue: Array<{
    readonly sink: RotatingFileSink;
    readonly filePath: string;
    readonly text: string | Buffer;
    readonly bytes: number;
  }> = [];
  let queuedBytes = 0;
  let inFlight: Promise<void> | null = null;
  let failures: Array<FileOperationFailure> = [];
  let droppedRecords = 0;
  let droppedBytes = 0;
  const brokenSinks = new WeakSet<RotatingFileSink>();

  const startNextWrite = () => {
    if (inFlight !== null) return;
    let next = queue.shift();
    while (next !== undefined && brokenSinks.has(next.sink)) {
      queuedBytes -= next.bytes;
      next = queue.shift();
    }
    if (next === undefined) return;
    queuedBytes -= next.bytes;
    const write = next;
    inFlight = write.sink
      .writeAsync(write.text)
      .then(
        () => undefined,
        (cause: unknown) => {
          brokenSinks.add(write.sink);
          failures.push({ filePath: write.filePath, cause });
        },
      )
      .then(() => {
        inFlight = null;
        startNextWrite();
      });
  };

  return {
    enqueue: (sink, filePath, text) => {
      const bytes = Buffer.byteLength(text);
      queue.push({ sink, filePath, text, bytes });
      queuedBytes += bytes;
      while (queuedBytes > MAX_QUEUED_WRITE_BYTES && queue.length > 1) {
        const dropped = queue.shift()!;
        queuedBytes -= dropped.bytes;
        droppedRecords += countLines(dropped.text);
        droppedBytes += dropped.bytes;
      }
      startNextWrite();
    },
    isBroken: (sink) => brokenSinks.has(sink),
    takeReport: () => {
      const report = { failures, droppedRecords, droppedBytes };
      failures = [];
      droppedRecords = 0;
      droppedBytes = 0;
      return report;
    },
    drain: async () => {
      for (let pending = inFlight; pending !== null; pending = inFlight) await pending;
    },
  };
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  return stream === "native" ? "NTIVE" : stream === "orchestration" ? "ORCH" : "CANON";
}

function providerLogPrefix(filePath: string): string {
  const basename = NodePath.basename(filePath);
  const extension = NodePath.extname(basename);
  return `${extension.length > 0 ? basename.slice(0, -extension.length) : basename}.`;
}

function providerLogPath(directory: string, prefix: string, threadSegment: string): string {
  return NodePath.join(directory, `${prefix}${threadSegment}.log`);
}

function shouldPersistProviderEvent(stream: EventNdjsonStream, event: unknown): boolean {
  if (stream === "orchestration" || typeof event !== "object" || event === null) {
    return true;
  }
  try {
    const type = Reflect.get(event, "type");
    if (typeof type === "string" && transientCanonicalEventTypes.has(type)) {
      return false;
    }
    if (stream !== "native") return true;

    const nested = Reflect.get(event, "event");
    const envelope = typeof nested === "object" && nested !== null ? nested : event;
    // Decoded frames carry the same information as raw frames without another
    // copy of every token delta. Decode failures have their own diagnostic frame.
    if (Reflect.get(envelope, "stage") === "raw") return false;
    const decodedPayload = Reflect.get(envelope, "payload");
    const nativeEvent =
      Reflect.get(envelope, "stage") === "decoded" &&
      typeof decodedPayload === "object" &&
      decodedPayload !== null
        ? decodedPayload
        : envelope;
    const method = Reflect.get(nativeEvent, "method");
    if (
      typeof method === "string" &&
      (transientNativeMethods.has(method) ||
        method.startsWith("claude/stream_event/content_block_delta/"))
    ) {
      return false;
    }

    const nativeType = Reflect.get(nativeEvent, "type");
    if (nativeType === "system" && Reflect.get(nativeEvent, "subtype") === "thinking_tokens") {
      return false;
    }
    if (nativeType === "message.part.delta") return false;
    if (nativeType === "stream_event") {
      const streamEvent = Reflect.get(nativeEvent, "event");
      if (
        typeof streamEvent === "object" &&
        streamEvent !== null &&
        Reflect.get(streamEvent, "type") === "content_block_delta"
      ) {
        return false;
      }
    }

    const payload = Reflect.get(nativeEvent, "payload");
    if (typeof payload !== "object" || payload === null) return true;

    if (method === "session/update") {
      const update = Reflect.get(payload, "update");
      if (typeof update !== "object" || update === null) return true;
      const updateType = Reflect.get(update, "sessionUpdate");
      return typeof updateType !== "string" || !transientAcpUpdates.has(updateType);
    }

    if (nativeType === "message.part.updated") {
      const properties = Reflect.get(payload, "properties");
      if (typeof properties !== "object" || properties === null) return true;
      const part = Reflect.get(properties, "part");
      if (typeof part !== "object" || part === null) return true;
      const partType = Reflect.get(part, "type");
      if (partType === "text" || partType === "reasoning") return false;
      if (partType === "tool") {
        // Running snapshots repeat growing output. Pending and terminal states stay in the log.
        const state = Reflect.get(part, "state");
        if (typeof state === "object" && state !== null) {
          return Reflect.get(state, "status") !== "running";
        }
      }
      return true;
    }

    return true;
  } catch {
    return true;
  }
}

const summaryFields = [
  "provider",
  "protocol",
  "kind",
  "providerSessionId",
  "direction",
  "stage",
  "type",
  "subtype",
  "method",
  "id",
  "threadId",
  "turnId",
  "requestId",
  "session_id",
  "status",
  "is_error",
  "api_error_status",
  "terminal_reason",
  "stop_reason",
  "operation",
  "code",
  "willRetry",
  "message",
  "event",
  "payload",
  "params",
  "result",
  "thread",
  "turn",
  "error",
  "turns",
  "items",
  "content",
] as const;

function summarizeProviderEvent(event: unknown): unknown {
  let remainingFields = 128;
  let remainingCharacters = 8 * 1024;
  const summarize = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      if (value.length > Math.min(1_024, remainingCharacters)) {
        return { omittedCharacters: value.length };
      }
      remainingCharacters -= value.length;
      return value;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") return undefined;
    if (Array.isArray(value)) return { itemCount: value.length };
    const summary: Record<string, unknown> = { truncated: true };
    if (depth >= 6) return summary;
    for (const key of summaryFields) {
      if (remainingFields <= 0) break;
      const nested = Reflect.get(value, key);
      if (nested === undefined) continue;
      remainingFields -= 1;
      summary[key] = summarize(nested, depth + 1);
    }
    return summary;
  };
  try {
    return summarize(event, 0);
  } catch {
    return { truncated: true };
  }
}

/** Bounds traversal before the logger encodes payloads. */
function boundProviderEventForLogging(event: unknown): unknown {
  let remainingCharacters = MAX_RECORD_CHARACTERS;
  let remainingFields = MAX_RECORD_FIELDS;
  const ancestors = new WeakSet<object>();
  const fits = (value: unknown, depth: number): boolean => {
    if (typeof value === "string") {
      remainingCharacters -= value.length;
      return remainingCharacters >= 0;
    }
    if (typeof value !== "object" || value === null) return true;
    if (depth > MAX_RECORD_DEPTH || ancestors.has(value)) return false;
    if (Array.isArray(value) && value.length > remainingFields) return false;
    ancestors.add(value);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      remainingFields -= 1;
      remainingCharacters -= key.length;
      if (
        remainingFields < 0 ||
        remainingCharacters < 0 ||
        !fits(Reflect.get(value, key), depth + 1)
      )
        return false;
    }
    ancestors.delete(value);
    return true;
  };
  const withinBudget = (value: unknown): boolean => {
    remainingCharacters = MAX_RECORD_CHARACTERS;
    remainingFields = MAX_RECORD_FIELDS;
    try {
      return fits(value, 0);
    } catch {
      // A failing accessor must not escape into provider processing.
      return false;
    }
  };
  if (withinBudget(event)) return event;
  // A screenshot or other binary result can push one tool call past the whole
  // record budget. Keep the call (title, id, status, name) and replace only the
  // pixels: summarizing the entire event threw the call away with them.
  const mediaBounded = boundEmbeddedBinary(event);
  if (mediaBounded !== event && withinBudget(mediaBounded)) return mediaBounded;
  return summarizeProviderEvent(mediaBounded);
}

/** Anything smaller is a screenshot thumbnail, not the payload a call carries. */
const MAX_EMBEDDED_BINARY_CHARS = 8 * 1024;
const DATA_URL_PATTERN = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,/i;
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/=\r\n]+$/;

/**
 * Replaces large embedded binary strings (a screenshot, an audio clip) with
 * their length. The surrounding structure is copied only when something was
 * actually replaced, so ordinary events are never touched.
 */
function boundEmbeddedBinary(event: unknown): unknown {
  const ancestors = new WeakSet<object>();
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      if (
        value.length > MAX_EMBEDDED_BINARY_CHARS &&
        (DATA_URL_PATTERN.test(value) || BASE64_BODY_PATTERN.test(value))
      ) {
        return { omittedCharacters: value.length };
      }
      return value;
    }
    if (typeof value !== "object" || value === null) return value;
    if (depth > MAX_RECORD_DEPTH || ancestors.has(value)) return value;
    ancestors.add(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((entry) => {
        const bounded = walk(entry, depth + 1);
        if (bounded !== entry) changed = true;
        return bounded;
      });
      ancestors.delete(value);
      return changed ? next : value;
    }
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const bounded = walk(Reflect.get(value, key), depth + 1);
      if (bounded !== Reflect.get(value, key)) changed = true;
      next[key] = bounded;
    }
    ancestors.delete(value);
    return changed ? next : value;
  };
  try {
    return walk(event, 0);
  } catch {
    // A failing accessor must not escape into provider processing; the caller
    // falls back to the summary.
    return event;
  }
}

export function writeBatchedMessages(
  sink: Pick<RotatingFileSink, "write">,
  records: ReadonlyArray<PendingRecord>,
  maxBytes: number,
  onWritten: (records: ReadonlyArray<PendingRecord>) => void,
): void {
  let pendingRecords: Array<PendingRecord> = [];
  let pendingBytes = 0;

  const flush = () => {
    if (pendingRecords.length === 0) return;
    const writtenRecords = pendingRecords;
    sink.write(writtenRecords.map((record) => record.line).join(""));
    onWritten(writtenRecords);
    pendingRecords = [];
    pendingBytes = 0;
  };

  for (const record of records) {
    if (pendingBytes > 0 && pendingBytes + record.bytes > maxBytes) {
      flush();
    }
    pendingRecords.push(record);
    pendingBytes += record.bytes;
    if (pendingBytes >= maxBytes) {
      flush();
    }
  }
  flush();
}

async function isProviderLogFileAsync(
  filePath: string,
  fileName: string,
  filePrefix: string,
): Promise<boolean> {
  if (!/\.log(?:\.\d+)?$/u.test(fileName)) return false;
  if (fileName.startsWith(filePrefix)) return true;

  const handle = await NodeFSP.open(filePath, "r");
  try {
    const header = Buffer.alloc(256);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    return /^\[[^\]\r\n]+\] (?:NTIVE|CANON|ORCH): /u.test(header.toString("utf8", 0, bytesRead));
  } finally {
    await handle.close();
  }
}

/**
 * The 5-minute retention pass reads the whole provider-log directory (77 files,
 * hundreds of MB live) and runs on the server's event loop, so every call is
 * asynchronous: on a busy disk a single statSync here held every request for
 * seconds. Behaviour is unchanged (same filters, same ordering, same failures);
 * removal stays `force` and never touches an active sink.
 */
async function enforceRetentionAsync(input: {
  readonly directory: string;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly activeFilePaths: ReadonlySet<string>;
  readonly filePrefix: string;
  readonly now: number;
}): Promise<RetentionResult> {
  const failures: Array<FileOperationFailure> = [];
  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = await NodeFSP.readdir(input.directory, { withFileTypes: true });
  } catch (cause) {
    return { failures: [{ filePath: input.directory, cause }] };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = NodePath.join(input.directory, entry.name);
    try {
      if (!(await isProviderLogFileAsync(filePath, entry.name, input.filePrefix))) continue;
      const stat = await NodeFSP.stat(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const remove = async (file: (typeof files)[number]): Promise<boolean> => {
    if (input.activeFilePaths.has(file.filePath)) return false;
    try {
      await NodeFSP.rm(file.filePath, { force: true });
      totalBytes -= file.size;
      return true;
    } catch (cause) {
      failures.push({ filePath: file.filePath, cause });
      return false;
    }
  };

  const retained: Array<(typeof files)[number]> = [];
  for (const file of files) {
    if (input.now - file.mtimeMs <= input.maxAgeMs || !(await remove(file))) retained.push(file);
  }

  for (const file of retained.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath),
  )) {
    if (totalBytes <= input.maxTotalBytes) break;
    await remove(file);
  }

  return { failures };
}

function validateOption(input: {
  readonly filePath: string;
  readonly option: string;
  readonly value: number;
  readonly minimum: number;
}): EventNdjsonLogConfigurationError | undefined {
  if (Number.isInteger(input.value) && input.value >= input.minimum) return undefined;
  return new EventNdjsonLogConfigurationError(input);
}

function resolveOptions(
  filePath: string,
  options: EventNdjsonLogStoreOptions,
): Effect.Effect<ResolvedOptions, EventNdjsonLogConfigurationError> {
  const resolved = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    batchWindowMs: options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    retentionCheckIntervalMs:
      options.retentionCheckIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    maxBufferedRecords: options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS,
    attribution: options.attribution,
  } satisfies ResolvedOptions;

  const validations = [
    ["maxBytes", resolved.maxBytes, 1],
    ["maxFiles", resolved.maxFiles, 1],
    ["batchWindowMs", resolved.batchWindowMs, 0],
    ["maxTotalBytes", resolved.maxTotalBytes, 1],
    ["maxAgeMs", resolved.maxAgeMs, 1],
    ["retentionCheckIntervalMs", resolved.retentionCheckIntervalMs, 1],
    ["maxBufferedBytes", resolved.maxBufferedBytes, 1],
    ["maxBufferedRecords", resolved.maxBufferedRecords, 1],
  ] as const;

  for (const [option, value, minimum] of validations) {
    const error = validateOption({ filePath, option, value, minimum });
    if (error) return Effect.fail(error);
  }
  return Effect.succeed(resolved);
}

function drainPending(input: {
  readonly directory: string;
  readonly options: ResolvedOptions;
  readonly state: StoreState;
  readonly filePrefix: string;
  readonly now: number;
  readonly timerFired: boolean;
  readonly close: boolean;
  readonly writer: BackgroundWriter | undefined;
}): readonly [DrainResult, StoreState] {
  if (input.state.closed) {
    return [{ attributions: [], failures: [] }, input.state];
  }

  const sinks = new Map(input.state.sinks);
  const failures: Array<FileOperationFailure> = [];
  const attributionByStream = new Map<
    EventNdjsonStream,
    { count: number; logicalWriteBytes: number }
  >();
  const recordsBySegment = new Map<string, Array<PendingRecord>>();

  for (const record of input.state.pending) {
    const records = recordsBySegment.get(record.threadSegment) ?? [];
    records.push(record);
    recordsBySegment.set(record.threadSegment, records);
  }

  for (const [threadSegment, records] of recordsBySegment) {
    const filePath = providerLogPath(input.directory, input.filePrefix, threadSegment);
    let sink = sinks.get(threadSegment);
    if (sink && input.writer?.isBroken(sink)) {
      sinks.delete(threadSegment);
      sink = undefined;
    }
    if (!sink) {
      try {
        sink = new RotatingFileSink({
          filePath,
          maxBytes: input.options.maxBytes,
          maxFiles: input.options.maxFiles,
          throwOnError: true,
        });
        sinks.set(threadSegment, sink);
      } catch (cause) {
        failures.push({ filePath, cause });
        continue;
      }
    }

    const target = sink;
    const writer = input.writer;
    try {
      const destination: Pick<RotatingFileSink, "write"> =
        writer === undefined ? target : { write: (text) => writer.enqueue(target, filePath, text) };
      writeBatchedMessages(destination, records, input.options.maxBytes, (writtenRecords) => {
        for (const record of writtenRecords) {
          const current = attributionByStream.get(record.stream) ?? {
            count: 0,
            logicalWriteBytes: 0,
          };
          attributionByStream.set(record.stream, {
            count: current.count + 1,
            logicalWriteBytes: current.logicalWriteBytes + record.bytes,
          });
        }
      });
    } catch (cause) {
      sinks.delete(threadSegment);
      failures.push({ filePath, cause });
    }
  }

  return [
    {
      attributions: Array.from(attributionByStream, ([stream, value]) => ({
        stream,
        ...value,
      })),
      failures,
    },
    {
      pending: [],
      pendingBytes: 0,
      sinks,
      flushScheduled: input.timerFired ? false : input.state.flushScheduled,
      closed: input.close,
      lastRetentionAt: input.state.lastRetentionAt,
    },
  ];
}

function countLines(text: string | Buffer): number {
  // Every record is one line, so this is the record count of a batch.
  const value = typeof text === "string" ? text : text.toString("utf8");
  let count = 0;
  for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

const serializeEvent = Effect.fnUntraced(function* (event: unknown) {
  return yield* encodeUnknownJsonString(event).pipe(
    Effect.catch((error) =>
      logWarning("failed to serialize provider event log record", {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  );
});

export const makeEventNdjsonLogStore = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLogStoreOptions = {},
): Effect.fn.Return<EventNdjsonLogStore, EventNdjsonLogStoreError> {
  const resolved = yield* resolveOptions(filePath, options);
  const directory = NodePath.dirname(filePath);
  const filePrefix = providerLogPrefix(filePath);
  const writer = providerLogAsyncEnabled(process.env.T3CODE_PROVIDER_LOG_ASYNC)
    ? makeBackgroundWriter()
    : undefined;

  yield* Effect.try({
    try: () => NodeFS.mkdirSync(directory, { recursive: true }),
    catch: (cause) => new EventNdjsonLogDirectoryError({ directory, cause }),
  });

  const initializedAt = yield* Clock.currentTimeMillis;
  // Per-directory failures come back in the result; the promise itself only
  // rejects on a programming error, which stays a defect.
  const initialRetention = yield* Effect.promise(() =>
    enforceRetentionAsync({
      directory,
      maxTotalBytes: resolved.maxTotalBytes,
      maxAgeMs: resolved.maxAgeMs,
      activeFilePaths: new Set(),
      filePrefix,
      now: initializedAt,
    }),
  );
  for (const failure of initialRetention.failures) {
    yield* logWarning("provider event log retention failed", {
      filePath: failure.filePath,
      errorTag: errorTag(failure.cause),
    });
  }

  const stateRef = yield* SynchronizedRef.make<StoreState>({
    pending: [],
    pendingBytes: 0,
    sinks: new Map(),
    flushScheduled: false,
    closed: false,
    lastRetentionAt: initializedAt,
  });
  const timerScope = yield* Scope.make();

  const flush = Effect.fnUntraced(function* (timerFired: boolean, close: boolean) {
    const startedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
      const result = drainPending({
        directory,
        options: resolved,
        state,
        filePrefix,
        now: startedAt,
        timerFired,
        close,
        writer,
      });
      const [drainResult, drainedState] = result;
      // The due-check and the timestamp move together under the lock, so two
      // overlapping flushes cannot both run the pass.
      const retentionDue =
        !drainedState.closed &&
        startedAt - state.lastRetentionAt >= resolved.retentionCheckIntervalMs;
      return Effect.succeed([
        {
          result: drainResult,
          retentionDue,
          activeFilePaths: new Set(
            Array.from(drainedState.sinks.keys(), (threadSegment) =>
              providerLogPath(directory, filePrefix, threadSegment),
            ),
          ),
        },
        retentionDue ? { ...drainedState, lastRetentionAt: startedAt } : drainedState,
      ] as const);
    });

    // The retention pass reads the whole log directory, so it runs off the
    // event loop, outside the state lock: a slow disk holds this fiber, not
    // every request behind it.
    if (outcome.retentionDue) {
      const retention = yield* Effect.promise(() =>
        enforceRetentionAsync({
          directory,
          maxTotalBytes: resolved.maxTotalBytes,
          maxAgeMs: resolved.maxAgeMs,
          activeFilePaths: outcome.activeFilePaths,
          filePrefix,
          now: startedAt,
        }),
      );
      for (const failure of retention.failures) {
        yield* logWarning("provider event log retention failed", {
          filePath: failure.filePath,
          errorTag: errorTag(failure.cause),
        });
      }
    }

    // On close, wait for the background appends so shutdown keeps every drained line.
    if (writer !== undefined && close) yield* Effect.promise(() => writer.drain());

    const result = outcome.result;
    const background = writer?.takeReport();
    for (const failure of [...result.failures, ...(background?.failures ?? [])]) {
      yield* logWarning("provider event log write or retention failed", {
        filePath: failure.filePath,
        errorTag: errorTag(failure.cause),
      });
    }
    if (background !== undefined && background.droppedRecords > 0) {
      yield* logWarning("provider event log writes fell behind the disk; oldest lines dropped", {
        records: background.droppedRecords,
        bytes: background.droppedBytes,
      });
    }

    if (resolved.attribution && result.attributions.length > 0) {
      const completedAt = yield* Clock.currentTimeMillis;
      const durationMs = Math.max(0, completedAt - startedAt);
      const totalBytes = result.attributions.reduce(
        (total, entry) => total + entry.logicalWriteBytes,
        0,
      );
      yield* Effect.forEach(
        result.attributions,
        (entry) =>
          resolved.attribution?.record({
            component: "provider-event-log",
            operation: `${entry.stream}.append`,
            logicalWriteBytes: entry.logicalWriteBytes,
            count: entry.count,
            durationMs:
              totalBytes === 0
                ? 0
                : Math.round(durationMs * (entry.logicalWriteBytes / totalBytes)),
          }) ?? Effect.void,
        { discard: true },
      );
    }
  });

  const scheduleFlush = Effect.fnUntraced(function* () {
    yield* Effect.forkIn(
      Effect.sleep(resolved.batchWindowMs).pipe(Effect.andThen(flush(true, false))),
      timerScope,
      { startImmediately: true },
    );
  });

  const close = Effect.fnUntraced(function* () {
    yield* flush(false, true);
    yield* Scope.close(timerScope, Exit.void);
  });

  const loggerViews = new Map<EventNdjsonStream, EventNdjsonLogger>();
  const logger = (stream: EventNdjsonStream): EventNdjsonLogger => {
    const existing = loggerViews.get(stream);
    if (existing) return existing;

    const write = Effect.fnUntraced(function* (event: unknown, threadId: ThreadId | null) {
      if (!shouldPersistProviderEvent(stream, event)) return;
      let payload = yield* serializeEvent(boundProviderEventForLogging(event));
      if (payload === undefined) return;
      // Escaping can expand strings beyond their input size. Keep that bounded
      // serialization out of the file too, while retaining routing/error fields.
      if (Buffer.byteLength(payload) > MAX_RECORD_CHARACTERS) {
        payload = yield* serializeEvent(summarizeProviderEvent(event));
        if (payload === undefined) return;
      }
      // A saved key a bot printed (tool output, a reply) must not outlive the chat in this file.
      payload = secretRedactor.redactText(payload);

      const observedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const line = `[${observedAt}] ${resolveStreamLabel(stream)}: ${payload}\n`;
      const bytes = Buffer.byteLength(line);
      const action = yield* SynchronizedRef.modifyEffect(stateRef, (state) => {
        if (state.closed) {
          return Effect.succeed([{ flush: false }, state] as const);
        }
        const pending = state.pending;
        pending.push({ stream, threadSegment: resolveThreadSegment(threadId), line, bytes });
        const pendingBytes = state.pendingBytes + bytes;
        const flush =
          resolved.batchWindowMs === 0 ||
          pending.length >= resolved.maxBufferedRecords ||
          pendingBytes >= resolved.maxBufferedBytes;
        const schedule = !flush && !state.flushScheduled;
        const nextState = {
          ...state,
          pending,
          pendingBytes,
          flushScheduled: state.flushScheduled || schedule,
        };
        return (schedule ? scheduleFlush() : Effect.void).pipe(
          Effect.as([{ flush }, nextState] as const),
        );
      }).pipe(Effect.uninterruptible);

      if (action.flush) {
        yield* flush(false, false);
      }
    });

    const view = { filePath, write, close: () => Effect.void } satisfies EventNdjsonLogger;
    loggerViews.set(stream, view);
    return view;
  };

  return { filePath, logger, close } satisfies EventNdjsonLogStore;
});

export const makeEventNdjsonLogger = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const store = yield* makeEventNdjsonLogStore(filePath, options).pipe(
    Effect.catch((error) =>
      logWarning(error.message, { error }).pipe(
        Effect.as<EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );
  if (!store) return undefined;
  return { ...store.logger(options.stream), close: store.close };
});
