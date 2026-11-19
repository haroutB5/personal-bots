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
  /** The part of `ms` that held the JS thread (stringify and size check). */
  readonly jsMs: number;
  readonly bytes: number;
}

interface ListCommit {
  /** When the list's layout effect ran. */
  readonly at: number;
  /** From the top of the list's render to that layout effect. */
  readonly ms: number;
  readonly rows: number;
}

const reads = new Map<string, CacheRead>();
/** The latest list commit with rows per chat, kept until an open takes it. */
const listCommits = new Map<string, ListCommit>();
interface RequestMark {
  readonly at: number;
  /** The request left at the tap, before the screen mounted. */
  readonly prefetched: boolean;
  responseMs?: number;
  decodeMs?: number;
}

/** Recent request starts per chat, oldest first; an open takes the first one after it began. */
const requests = new Map<string, RequestMark[]>();
let slowestWrite: CacheWrite | null = null;
let writeCount = 0;

export function noteCacheRead(threadId: string, read: CacheRead): string {
  reads.set(threadId, read);
  return `[perf] cache-read-ms ${Math.round(read.ms)} bytes ${read.bytes} decode-ms ${Math.round(read.decodeMs)} ${read.hit ? "hit" : "miss"}`;
}

/**
 * The list committed rows. Each list notes once per mount, so the newest note is the one that
 * belongs to the open in progress: a chat opened with no rows reports before its rows commit,
 * and that late note must not hold the place of the next open's.
 */
export function noteListCommit(threadId: string, commit: ListCommit): void {
  listCommits.set(threadId, commit);
}

export function noteRequestStart(threadId: string, at: number, prefetched = false): void {
  requests.set(threadId, [...(requests.get(threadId) ?? []).slice(-3), { at, prefetched }]);
}

/** The request that left at `startedAt` got its response and decoded it in these times. */
export function noteRequestDone(
  threadId: string,
  startedAt: number,
  timings: { readonly responseMs: number; readonly decodeMs: number },
): void {
  const mark = requests.get(threadId)?.find((entry) => entry.at === startedAt);
  if (mark === undefined) return;
  mark.responseMs = timings.responseMs;
  mark.decodeMs = timings.decodeMs;
}

export function noteCacheWrite(write: CacheWrite): string {
  writeCount += 1;
  if (slowestWrite === null || write.ms > slowestWrite.ms) slowestWrite = write;
  return `[perf] cache-write-ms ${Math.round(write.ms)} bytes ${write.bytes} js-ms ${Math.round(write.jsMs)}`;
}

export interface ChatOpenReport {
  readonly line: string;
  readonly body: Record<string, number | string | boolean>;
}

/**
 * The report for a chat that first painted data at `paintedAt` after opening at `openedAt`.
 * `ms` counts from the mount. `fromTapMs` counts from the press, and a request that left at
 * the press belongs to this open. Marks older than this open are ignored; reported marks clear.
 */
export function takeChatOpenReport(
  threadId: string,
  openedAt: number,
  paintedAt: number,
  tapAt?: number,
  processStartAt?: number,
): ChatOpenReport {
  const startedAt = tapAt === undefined ? openedAt : Math.min(tapAt, openedAt);
  const read = reads.get(threadId);
  const ownRead = read !== undefined && read.at >= openedAt ? read : undefined;
  const ownMark = requests.get(threadId)?.find((mark) => mark.at >= startedAt);
  const ownRequest = ownMark?.at;
  const listCommit = listCommits.get(threadId);
  const ownList = listCommit !== undefined && listCommit.at >= openedAt ? listCommit : undefined;
  reads.delete(threadId);
  requests.delete(threadId);
  listCommits.delete(threadId);
  // A copy that arrived after the request left was too late: the deadline had passed it over.
  const store: ChatOpenStore =
    ownRead?.hit === true && (ownRequest === undefined || ownRead.at <= ownRequest)
      ? "cache"
      : ownRequest !== undefined || ownRead !== undefined
        ? "network"
        : "memory";
  const ms = Math.round(paintedAt - openedAt);
  const requestAtMs =
    ownRequest === undefined ? undefined : Math.max(0, Math.round(ownRequest - openedAt));
  const write = slowestWrite;
  const writes = writeCount;
  slowestWrite = null;
  writeCount = 0;
  const body: Record<string, number | string | boolean> = {
    event: "perf",
    journey: "a-chat-open",
    ms,
    store,
  };
  if (tapAt !== undefined) body.fromTapMs = Math.round(paintedAt - startedAt);
  if (requestAtMs !== undefined) body.requestAtMs = requestAtMs;
  if (ownMark?.prefetched === true) body.prefetched = true;
  if (ownMark?.responseMs !== undefined) body.responseMs = Math.round(ownMark.responseMs);
  if (ownMark?.decodeMs !== undefined) body.decodeMs = Math.round(ownMark.decodeMs);
  if (ownRead !== undefined) {
    body.readMs = Math.round(ownRead.ms);
    body.readBytes = ownRead.bytes;
  }
  if (processStartAt !== undefined) body.processToOpenMs = Math.round(startedAt - processStartAt);
  if (ownList !== undefined) {
    body.listMs = Math.round(ownList.ms);
    body.rows = ownList.rows;
  }
  if (write !== null) {
    body.writeMs = Math.round(write.ms);
    body.writeBytes = write.bytes;
    body.writes = writes;
  }
  return {
    line: `[perf] chat-open-ms ${ms} ${store} request-at-ms ${requestAtMs ?? "-"}${
      tapAt === undefined ? "" : ` from-tap-ms ${body.fromTapMs}`
    }${ownList === undefined ? "" : ` list-ms ${body.listMs}`}${
      processStartAt === undefined ? "" : ` process-ms ${body.processToOpenMs}`
    }`,
    body,
  };
}
