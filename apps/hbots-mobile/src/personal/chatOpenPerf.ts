/**
 * Stage timings of a chat open (saved-copy read, request start, first data frame, slowest
 * saved-copy write since the last line), for logcat and the server's client-diag log.
 * Durations and sizes only: no chat text, thread id or key material leaves here.
 */

export type ChatOpenStore = "cache" | "network" | "memory";

interface CacheRead {
  /** When the read finished. */
  readonly at: number;
  readonly ms: number;
  readonly decodeMs: number;
  readonly bytes: number;
  readonly hit: boolean;
}

interface CacheWrite {
  readonly ms: number;
  readonly bytes: number;
}

const reads = new Map<string, CacheRead>();
/** Recent request starts per chat, oldest first; an open takes the first one after it began. */
const requests = new Map<string, number[]>();
let slowestWrite: CacheWrite | null = null;
let writeCount = 0;

export function noteCacheRead(threadId: string, read: CacheRead): string {
  reads.set(threadId, read);
  return `[perf] cache-read-ms ${Math.round(read.ms)} bytes ${read.bytes} decode-ms ${Math.round(read.decodeMs)} ${read.hit ? "hit" : "miss"}`;
}

export function noteRequestStart(threadId: string, at: number): void {
  requests.set(threadId, [...(requests.get(threadId) ?? []).slice(-3), at]);
}

export function noteCacheWrite(write: CacheWrite): string {
  writeCount += 1;
  if (slowestWrite === null || write.ms > slowestWrite.ms) slowestWrite = write;
  return `[perf] cache-write-ms ${Math.round(write.ms)} bytes ${write.bytes}`;
}

export interface ChatOpenReport {
  readonly line: string;
  readonly body: Record<string, number | string>;
}

/**
 * The report for a chat that first painted data at `paintedAt` after opening at `openedAt`.
 * A cache read or request older than this open belongs to an earlier one and is ignored.
 * Clears what it reported, so the next open of the same chat starts clean.
 */
export function takeChatOpenReport(
  threadId: string,
  openedAt: number,
  paintedAt: number,
): ChatOpenReport {
  const read = reads.get(threadId);
  const ownRead = read !== undefined && read.at >= openedAt ? read : undefined;
  const ownRequest = requests.get(threadId)?.find((at) => at >= openedAt);
  reads.delete(threadId);
  requests.delete(threadId);
  // A copy that arrived after the request left was too late: the deadline had passed it over.
  const store: ChatOpenStore =
    ownRead?.hit === true && (ownRequest === undefined || ownRead.at <= ownRequest)
      ? "cache"
      : ownRequest !== undefined || ownRead !== undefined
        ? "network"
        : "memory";
  const ms = Math.round(paintedAt - openedAt);
  const requestAtMs = ownRequest === undefined ? undefined : Math.round(ownRequest - openedAt);
  const write = slowestWrite;
  const writes = writeCount;
  slowestWrite = null;
  writeCount = 0;
  const body: Record<string, number | string> = {
    event: "perf",
    journey: "a-chat-open",
    ms,
    store,
  };
  if (requestAtMs !== undefined) body.requestAtMs = requestAtMs;
  if (ownRead !== undefined) {
    body.readMs = Math.round(ownRead.ms);
    body.readBytes = ownRead.bytes;
  }
  if (write !== null) {
    body.writeMs = Math.round(write.ms);
    body.writeBytes = write.bytes;
    body.writes = writes;
  }
  return {
    line: `[perf] chat-open-ms ${ms} ${store} request-at-ms ${requestAtMs ?? "-"}`,
    body,
  };
}
