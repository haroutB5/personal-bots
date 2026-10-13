// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The DeepSeek Harness's usage ledger: dsh's own session log, rewritten in the
 * Claude transcript shape the rest of hbots already reads.
 *
 * ACP carries no billing tokens — only `usage_update {used, size}`, a context
 * meter. The per-step truth lives in dsh's session log
 * (`$DSH_HOME/sessions/<encoded cwd>/<sessionId>/session.v4.jsonl.zstd`): a
 * concatenation of zstd frames, one `assistant/message` event per committed
 * model step, each carrying `usage {inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens}` and the message id.
 *
 * This module decodes those frames incrementally (remembering the byte offset
 * of the last whole frame and the last `seq`) and appends one Claude-shaped
 * line per new assistant message to `$DSH_HOME/usage/<root session id>.jsonl`,
 * so the existing scanner, DeepSeek Flash pricing, per-bot attribution and the
 * balance card's "spent" all keep working unchanged.
 *
 * @module provider/dshUsageLedger
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Zlib from "node:zlib";

import { DEEPSEEK_FLASH_MODEL } from "@t3tools/contracts";

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
 * Decodes the zstd frames of a dsh session log from `fromOffset` on.
 *
 * The file is a concatenation of independently compressed frames, and a frame
 * still being written (or one cut mid-write) fails to decompress. Only whole
 * frames advance the returned offset, so the next read replays an unfinished
 * tail rather than losing it. A frame's magic can also occur inside compressed
 * data, so each candidate start is tried against every later one until one
 * span decodes.
 */
export function decodeDshSessionFrames(buffer: Buffer, fromOffset: number): DshFrameRead {
  const starts: number[] = [];
  for (let index = buffer.indexOf(ZSTD_MAGIC, fromOffset); index !== -1;) {
    starts.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + 1);
  }
  let lines: string[] = [];
  let offset = fromOffset;
  let index = 0;
  let wholeFrames = false;
  while (index < starts.length) {
    const start = starts[index]!;
    if (start < offset) {
      index += 1;
      continue;
    }
    let decoded: string | undefined;
    let nextIndex = index;
    for (let end = index + 1; end <= starts.length; end += 1) {
      const stop = end < starts.length ? starts[end]! : buffer.length;
      try {
        decoded = Zlib.zstdDecompressSync(buffer.subarray(start, stop)).toString("utf8");
        nextIndex = end;
        break;
      } catch {
        // Try a longer span: this "start" was compressed data, or the frame
        // after it is the same frame.
      }
    }
    if (decoded === undefined) break;
    lines = lines.concat(decoded.split("\n").filter((line) => line.trim().length > 0));
    offset = nextIndex < starts.length ? starts[nextIndex]! : buffer.length;
    wholeFrames = true;
    index = nextIndex;
  }
  // Nothing decodable from here: hold the offset where it was so the bytes are
  // read again next time (a frame mid-write, or a file that has not flushed).
  return { lines, offset: wholeFrames ? offset : fromOffset };
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

/**
 * One assistant step as the Claude transcript line the usage scanner reads.
 *
 * `requestId` is `<sessionId>:<seq>`: together with the message id it is the
 * scanner's de-duplication key, so re-reading a log can never bill a step
 * twice. `sessionId` is always the ROOT dsh session, so per-bot attribution
 * (which reads the chat's resume cursor) matches the ledger.
 */
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

/**
 * Subagent sessions of a root session: dsh logs a child session in the same
 * workspace folder and names its parent in the session header, so a chat's
 * spend includes the work its subagents did.
 *
 * Bounded on purpose: one pass reads the first bytes of at most
 * {@link MAX_CANDIDATES_PER_PASS} session folders it has not classified yet,
 * and only those in the root session's own workspace folder.
 */
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
