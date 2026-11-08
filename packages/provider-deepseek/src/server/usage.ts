// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/** The harness ledger and the transcript reader the shared usage scan reads. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

import type { DeepSeekSettings } from "../settings.ts";
import { DEEPSEEK_FLASH_MODEL } from "./catalog.ts";
import { DSH_HOME_DIR_NAME } from "./engine.ts";
import { resolveDeepSeekHomePath } from "./environment.ts";

/** The zstd frame magic, little-endian `0xFD2FB528`. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Where dsh keeps its session logs, under the harness home. */
export const dshSessionsDir = (dshHome: string): string => NodePath.join(dshHome, "sessions");

/** The ledger directory the usage scan reads as a second DeepSeek source. */
export const dshUsageDir = (dshHome: string): string => NodePath.join(dshHome, "usage");

/** `session.v4.jsonl.zstd` for one session, when it is on disk. */
export function dshSessionFilePath(dshHome: string, sessionId: string): string | undefined {
  const root = dshSessionsDir(dshHome);
  let folders: string[];
  try {
    folders = NodeFS.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const folder of folders) {
    const candidate = NodePath.join(root, folder, sessionId, "session.v4.jsonl.zstd");
    try {
      if (NodeFS.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this workspace's folder.
    }
  }
  return undefined;
}

/** The raw bytes of a session log, or nothing when it is not readable yet. */
export function readDshSessionBytes(file: string): Buffer | undefined {
  try {
    return NodeFS.readFileSync(file);
  } catch {
    return undefined;
  }
}

export interface DshFrameRead {
  /** Every whole JSON line decoded from `fromOffset` on. */
  readonly lines: ReadonlyArray<string>;
  /** The offset a later read should start at: past the last whole frame. */
  readonly offset: number;
}

/**
 * Exact frame length, or undefined until the whole frame is here. Guessing
 * from the next frame magic either swallows frames or splits one.
 */
function zstdFrameLength(buffer: Buffer, start: number): number | undefined {
  if (start + 5 > buffer.length) return undefined;
  const descriptor = buffer[start + 4]!;
  const contentSizeFlag = (descriptor >> 6) & 0b11;
  const singleSegment = ((descriptor >> 5) & 0b1) === 1;
  const checksum = ((descriptor >> 2) & 0b1) === 1;
  const dictionaryFlag = descriptor & 0b11;
  const contentSizeBytes =
    contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : ([2, 4, 8] as const)[contentSizeFlag - 1]!;
  const dictionaryBytes = ([0, 1, 2, 4] as const)[dictionaryFlag]!;
  let cursor = start + 5;
  if (!singleSegment) {
    if (cursor + 1 > buffer.length) return undefined;
    cursor += 1;
  }
  cursor += dictionaryBytes + contentSizeBytes;
  // Blocks: a 3-byte header holding the size in bits 3..23, then the payload.
  // Bit 0 marks the last block; an RLE block stores one byte whatever its size.
  for (;;) {
    if (cursor + 3 > buffer.length) return undefined;
    const value = buffer[cursor]! | (buffer[cursor + 1]! << 8) | (buffer[cursor + 2]! << 16);
    const lastBlock = (value & 0b1) === 1;
    const blockType = (value >> 1) & 0b11;
    const blockSize = value >>> 3;
    cursor += 3 + (blockType === 1 ? 1 : blockSize);
    // A block whose payload runs past the buffer is a frame still being
    // written, last block or not.
    if (cursor > buffer.length) return undefined;
    if (lastBlock) break;
  }
  // dsh's writer enables the frame checksum: four bytes after the last block.
  // A frame whose checksum has not arrived yet is still being written.
  if (checksum) {
    if (cursor + 4 > buffer.length) return undefined;
    cursor += 4;
  }
  return cursor - start;
}

/** Decodes whole zstd frames from `fromOffset`; a torn frame holds the offset. */
export function decodeDshSessionFrames(buffer: Buffer, fromOffset: number): DshFrameRead {
  const lines: string[] = [];
  let offset = fromOffset;
  for (;;) {
    // Everything before a frame's own magic is skipped: a frame starts there.
    const start = buffer.indexOf(ZSTD_MAGIC, offset);
    if (start === -1) break;
    const length = zstdFrameLength(buffer, start);
    if (length === undefined) break;
    const decoded = NodeZlib.zstdDecompressSync(buffer.subarray(start, start + length)).toString(
      "utf8",
    );
    lines.push(...decoded.split("\n").filter((line) => line.trim().length > 0));
    offset = start + length;
  }
  return { lines, offset };
}

/** One `assistant/message` step of a dsh session log. */
export interface DshAssistantStep {
  readonly seq: number;
  readonly timeMs: number;
  readonly messageId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

const asCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

/** Reads one decoded log line as an assistant step, or null for anything else. */
export function parseDshAssistantStep(line: string): DshAssistantStep | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const event = parsed as Record<string, unknown>;
  if (event["type"] !== "assistant/message") return null;
  const data = event["data"];
  if (typeof data !== "object" || data === null) return null;
  const dataRecord = data as Record<string, unknown>;
  const message = dataRecord["message"];
  const usage = dataRecord["usage"];
  if (typeof message !== "object" || message === null) return null;
  if (typeof usage !== "object" || usage === null) return null;
  const messageRecord = message as Record<string, unknown>;
  const usageRecord = usage as Record<string, unknown>;
  const messageId = messageRecord["id"];
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  const seq = event["seq"];
  const time = event["time"];
  const source = messageRecord["source"];
  const model =
    typeof source === "object" &&
    source !== null &&
    typeof (source as Record<string, unknown>)["model"] === "string"
      ? ((source as Record<string, unknown>)["model"] as string)
      : DEEPSEEK_FLASH_MODEL;
  return {
    seq: typeof seq === "number" && Number.isFinite(seq) ? Math.round(seq) : 0,
    timeMs: typeof time === "number" && Number.isFinite(time) ? Math.round(time) : Date.now(),
    messageId,
    model,
    inputTokens: asCount(usageRecord["inputTokens"]),
    outputTokens: asCount(usageRecord["outputTokens"]),
    cacheReadTokens: asCount(usageRecord["cacheReadTokens"]),
    cacheWriteTokens: asCount(usageRecord["cacheWriteTokens"]),
  };
}

/** The session id a dsh session log's own header names. */
export function parseDshSessionHeader(line: string): {
  readonly id: string;
  readonly parentSession?: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "session") return null;
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  const parent = record["parentSession"] ?? record["parentSessionId"] ?? record["parent"];
  return {
    id,
    ...(typeof parent === "string" && parent.length > 0 ? { parentSession: parent } : {}),
  };
}

/** One step as the Claude line the scan reads; requestId is the dedupe key. */
export function dshStepToTranscriptLine(input: {
  readonly step: DshAssistantStep;
  readonly rootSessionId: string;
}): string {
  const { step, rootSessionId } = input;
  return `${JSON.stringify({
    type: "assistant",
    timestamp: new Date(step.timeMs).toISOString(),
    sessionId: rootSessionId,
    requestId: `${rootSessionId}:${step.seq}`,
    message: {
      id: step.messageId,
      model: step.model,
      usage: {
        input_tokens: step.inputTokens,
        output_tokens: step.outputTokens,
        cache_read_input_tokens: step.cacheReadTokens,
        cache_creation_input_tokens: step.cacheWriteTokens,
      },
    },
  })}\n`;
}

/** How much of a candidate subagent session is read to find its header. */
const HEADER_READ_BYTES = 64 * 1024;
/** Candidates one discovery pass will open. */
const MAX_CANDIDATES_PER_PASS = 200;

/** Subagent sessions of a root session, bounded to one workspace pass. */
export function findDshDescendantSessions(input: {
  readonly dshHome: string;
  readonly rootSessionId: string;
  readonly sessionFilePath: string;
  readonly alreadyKnown: ReadonlySet<string>;
}): ReadonlyArray<{ readonly sessionId: string; readonly filePath: string }> {
  const workspaceFolder = NodePath.dirname(NodePath.dirname(input.sessionFilePath));
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(workspaceFolder, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Array<{ sessionId: string; filePath: string }> = [];
  let read = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === input.rootSessionId || input.alreadyKnown.has(entry.name)) continue;
    if (read >= MAX_CANDIDATES_PER_PASS) break;
    const filePath = NodePath.join(workspaceFolder, entry.name, "session.v4.jsonl.zstd");
    let bytes: Buffer;
    try {
      const handle = NodeFS.openSync(filePath, "r");
      try {
        bytes = Buffer.alloc(HEADER_READ_BYTES);
        const readBytes = NodeFS.readSync(handle, bytes, 0, HEADER_READ_BYTES, 0);
        bytes = bytes.subarray(0, readBytes);
      } finally {
        NodeFS.closeSync(handle);
      }
    } catch {
      continue;
    }
    read += 1;
    const header = decodeDshSessionFrames(bytes, 0)
      .lines.map((line) => parseDshSessionHeader(line))
      .find((parsed) => parsed !== null);
    if (header?.parentSession === undefined) continue;
    if (
      header.parentSession !== input.rootSessionId &&
      !input.alreadyKnown.has(header.parentSession)
    ) {
      continue;
    }
    found.push({ sessionId: header.id, filePath });
  }
  return found;
}

/** The seq numbers a ledger file already holds, so a restart never rewrites them. */
export function readLedgerLastSeq(ledgerPath: string, rootSessionId: string): number {
  let text: string;
  try {
    text = NodeFS.readFileSync(ledgerPath, "utf8");
  } catch {
    return -1;
  }
  const prefix = `"requestId":"${rootSessionId}:`;
  let last = -1;
  for (const line of text.split("\n")) {
    const start = line.indexOf(prefix);
    if (start === -1) continue;
    const value = Number.parseInt(line.slice(start + prefix.length), 10);
    if (Number.isFinite(value) && value > last) last = value;
  }
  return last;
}

/** Appends ledger lines, creating the directory. Returns how many were written. */
export function appendDshLedgerLines(ledgerPath: string, lines: ReadonlyArray<string>): number {
  if (lines.length === 0) return 0;
  NodeFS.mkdirSync(NodePath.dirname(ledgerPath), { recursive: true });
  NodeFS.appendFileSync(ledgerPath, lines.join(""), "utf8");
  return lines.length;
}

/**
 * One Claude-shaped ledger line as a DeepSeek record. Only the provider
 * differs, which selects DeepSeek's own pricing card.
 */
export function parseDeepSeekRecord(parsed: unknown): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;
  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const cost = record["costUSD"];
  return {
    provider: "deepseek",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
      cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usageRecord["output_tokens"]),
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey:
      messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`,
  };
}

/** Parses one line of a DeepSeek transcript or harness ledger. */
export function parseDeepSeekLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseDeepSeekRecord(parsed);
}

const toRecords = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const deepSeekUsageFormat: TranscriptUsageFormat<unknown> = {
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    speed: true,
    message: { id: true, model: true, usage: true },
  },
  usageMarkers: ['"usage"'],
  parseLine: (line) => toRecords(parseDeepSeekLine(line)),
  parseProjected: (projected) => toRecords(parseDeepSeekRecord(projected)),
};

export type DeepSeekUsageReaderEnv = Path.Path | ProviderHost.ProviderHost;

/** Both DeepSeek sources: Claude projects and the dsh ledger beside the state root. */
export const deepSeekUsageReader: ProviderUsageReader<DeepSeekSettings, DeepSeekUsageReaderEnv> = {
  kind: "transcripts",
  provider: "deepseek",
  format: deepSeekUsageFormat,
  directories: Effect.fn("deepSeekUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const home = yield* resolveDeepSeekHomePath(config ?? { homePath: "" }, environment);
    return [
      { dir: path.join(home, "projects") },
      { dir: path.join(host.paths.stateDir, DSH_HOME_DIR_NAME, "usage") },
    ];
  }),
};
