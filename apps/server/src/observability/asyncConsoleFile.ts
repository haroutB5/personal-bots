// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

/**
 * The launcher runs the server as `node bin.mjs serve ... >> server-YYYYMMDD.log
 * 2>&1` (scripts/personal/common.ps1), so stdout and stderr are file handles.
 * Node makes writes to file handles synchronous, so every console line - the
 * pretty logger, the stall recorder's own reports, Node warnings such as the
 * SDK's canUseTool notice - blocks the event loop for the disk's latency. Under
 * load (a backup, Defender, a VM) one line was measured holding every request
 * for seconds. This module swaps `write` on the two streams for one that hands
 * the queued bytes to `fs.write` on the threadpool: same bytes, same order per
 * stream, one write in flight; the loop never waits for the disk.
 *
 * One `fs.write` per line was not enough: a burst (the console probe writes
 * tens of thousands of lines) could only land as fast as one disk write at a
 * time, so the backlog grew without bound and a hard kill (`taskkill /F`, what
 * restart, -Stop and rollback all use) threw it away - QA 1.66.33 measured 845
 * of 74,500 accepted lines surviving a mid-burst kill. The queue is now
 * coalesced into batches of up to {@link MAX_BATCH_BYTES} per write, so a burst
 * drains in a handful of writes and a kill can only lose the batch in flight,
 * and it is bounded at {@link MAX_QUEUED_BYTES}: beyond that the oldest queued
 * lines are dropped and one marker line records how many, rather than growing
 * the server's memory without limit.
 *
 * Only regular-file handles are touched. A TTY (Node's own writes are already
 * asynchronous on Windows), a pipe (asynchronous everywhere, and `pair.ps1`
 * parses it), a NUL device and tests all keep the original write. A normal exit
 * flushes what is queued synchronously, and `T3CODE_ASYNC_CONSOLE=off` restores
 * the old behaviour.
 */

/** The most any one `fs.write` carries; a larger single chunk still goes alone. */
export const MAX_BATCH_BYTES = 1024 * 1024;

/**
 * The most queued bytes kept while a write is in flight. Beyond this the oldest
 * lines are dropped (the newest are the ones worth having after a hang) and one
 * marker line is written with the count.
 */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

const DROPPED_MARKER_PREFIX = "[async-console] dropped ";

export interface AsyncConsoleTarget {
  /** The stream to patch; only its `write` method is replaced. */
  readonly stream: object;
  readonly fd: number;
}

const INSTALLED = new WeakSet<object>();
const WRITERS = new WeakMap<object, AsyncFileWriter>();

function toBuffer(chunk: unknown, encoding: BufferEncoding | undefined): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, encoding ?? "utf8");
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(String(chunk), "utf8");
}

function countLines(buffer: Buffer): number {
  let lines = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0x0a) lines += 1;
  }
  return lines === 0 && buffer.length > 0 ? 1 : lines;
}

/**
 * A minimal serialized async writer for one file descriptor: chunk order is
 * preserved, exactly one `fs.write` is in flight, queued chunks are coalesced
 * into batches, partial writes are retried from their offset, and a failed
 * write stops accepting new lines rather than reordering them.
 */
export class AsyncFileWriter {
  private readonly fd: number;
  private readonly queue: Array<Buffer> = [];
  private queuedBytes = 0;
  private droppedLines = 0;
  private writing = false;
  private failed = false;
  /** Resolved when the queue and the in-flight write are done; see {@link flush}. */
  private readonly drainWaiters: Array<() => void> = [];

  constructor(fd: number) {
    this.fd = fd;
  }

  readonly write = (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (this.failed) {
      done?.();
      return false;
    }
    if (chunk !== undefined && chunk !== null) {
      const buffer = toBuffer(
        chunk,
        typeof encodingOrCallback === "string" ? encodingOrCallback : undefined,
      );
      this.queue.push(buffer);
      this.queuedBytes += buffer.length;
      this.trimBacklog();
      this.pump();
    }
    done?.();
    return true;
  };

  /** Bytes accepted but not yet written; tests use it to observe the backlog. */
  get backlogBytes(): number {
    return this.queuedBytes;
  }

  /** Lines dropped because the backlog hit its bound; tests use it to observe. */
  get droppedLineCount(): number {
    return this.droppedLines;
  }

  /**
   * Resolves once everything accepted so far has been written (or the writer
   * has failed and stopped accepting). There is no timer and no polling: the
   * promise settles on the write callback itself, so a caller never has to
   * guess how many event-loop turns a disk write takes.
   */
  flush(): Promise<void> {
    if (this.failed || (!this.writing && this.queue.length === 0)) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private settleDrain(): void {
    if (this.writing || this.queue.length > 0) return;
    for (const resolve of this.drainWaiters.splice(0)) resolve();
  }

  private trimBacklog(): void {
    while (this.queuedBytes > MAX_QUEUED_BYTES && this.queue.length > 0) {
      const dropped = this.queue.shift()!;
      this.queuedBytes -= dropped.length;
      this.droppedLines += countLines(dropped);
    }
  }

  private pump(): void {
    if (this.writing) return;
    const batch = this.takeBatch();
    if (batch === undefined) {
      this.settleDrain();
      return;
    }
    this.writing = true;
    this.writeBuffer(batch, 0);
  }

  /** Takes the next batch: everything queued up to the batch size, one chunk when it alone is bigger. */
  private takeBatch(): Buffer | undefined {
    if (this.queue.length === 0) return undefined;
    const parts: Array<Buffer> = [];
    let bytes = 0;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (parts.length > 0 && bytes + next.length > MAX_BATCH_BYTES) break;
      this.queue.shift();
      this.queuedBytes -= next.length;
      parts.push(next);
      bytes += next.length;
    }
    let batch = parts.length === 1 ? parts[0]! : Buffer.concat(parts, bytes);
    if (this.droppedLines > 0) {
      const marker = Buffer.from(
        `${DROPPED_MARKER_PREFIX}${this.droppedLines} earlier queued log line(s) under sustained load)\n`,
        "utf8",
      );
      this.droppedLines = 0;
      batch = Buffer.concat([marker, batch], marker.length + batch.length);
    }
    return batch;
  }

  private writeBuffer(buffer: Buffer, offset: number): void {
    NodeFS.write(this.fd, buffer, offset, buffer.length - offset, null, (error, written) => {
      if (error !== null && error !== undefined) {
        this.writing = false;
        this.failed = true;
        this.queue.length = 0;
        this.queuedBytes = 0;
        this.settleDrain();
        return;
      }
      const next = offset + written;
      if (next < buffer.length) {
        this.writeBuffer(buffer, next);
        return;
      }
      this.writing = false;
      this.pump();
    });
  }

  /** Best-effort synchronous drain of everything queued (process exit). */
  flushSync(): void {
    if (this.failed) return;
    const pending = this.queue.splice(0, this.queue.length);
    this.queuedBytes = 0;
    for (const buffer of pending) {
      try {
        NodeFS.writeSync(this.fd, buffer, 0, buffer.length, null);
      } catch {
        // A dying process has nowhere to report this; these lines only reached
        // the queue because the async path was not keeping up.
      }
    }
  }
}

/** The writer installed on a stream, or undefined when it kept its own write. */
export function asyncConsoleWriterFor(stream: object): AsyncFileWriter | undefined {
  return WRITERS.get(stream);
}

function isRegularFile(fd: number): boolean {
  try {
    return NodeFS.fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

/**
 * Swaps `write` on every target whose fd is a regular file. Returns the number
 * of streams redirected (0 when the kill switch is set or nothing is a file).
 * Safe to call more than once; an already-redirected stream is left alone.
 */
export function installAsyncConsoleFileRedirect(
  targets: ReadonlyArray<AsyncConsoleTarget> = [
    { stream: process.stdout, fd: 1 },
    { stream: process.stderr, fd: 2 },
  ],
): number {
  if (process.env.T3CODE_ASYNC_CONSOLE === "off") return 0;
  let redirected = 0;
  for (const target of targets) {
    if (INSTALLED.has(target.stream)) continue;
    if (!isRegularFile(target.fd)) continue;
    const writer = new AsyncFileWriter(target.fd);
    const writable = target.stream as { write?: unknown };
    try {
      writable.write = writer.write;
    } catch {
      continue;
    }
    INSTALLED.add(target.stream);
    WRITERS.set(target.stream, writer);
    process.on("exit", () => writer.flushSync());
    redirected += 1;
  }
  return redirected;
}
