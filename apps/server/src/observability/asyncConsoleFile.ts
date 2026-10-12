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
 * each line to `fs.write` on the threadpool: same bytes, same order per stream,
 * one write in flight; the loop never waits for the disk.
 *
 * Only regular-file handles are touched. A TTY (Node's own writes are already
 * asynchronous on Windows), a pipe (asynchronous everywhere, and `pair.ps1`
 * parses it), a NUL device and tests all keep the original write. A hard kill
 * can lose the last queued lines; a normal exit flushes what is queued
 * synchronously, and `T3CODE_ASYNC_CONSOLE=off` restores the old behaviour.
 */

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

/**
 * A minimal serialized async writer for one file descriptor: chunk order is
 * preserved, exactly one `fs.write` is in flight, partial writes are retried
 * from their offset, and a failed write stops accepting new lines rather than
 * reordering them.
 */
export class AsyncFileWriter {
  private readonly fd: number;
  private readonly queue: Array<Buffer> = [];
  private writing = false;
  private failed = false;

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
      this.queue.push(
        toBuffer(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : undefined),
      );
      this.pump();
    }
    done?.();
    return true;
  };

  /** Lines accepted but not yet written; tests use it to observe the queue. */
  get queuedChunks(): number {
    return this.queue.length;
  }

  private pump(): void {
    if (this.writing) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.writing = true;
    this.writeBuffer(next, 0);
  }

  private writeBuffer(buffer: Buffer, offset: number): void {
    NodeFS.write(this.fd, buffer, offset, buffer.length - offset, null, (error, written) => {
      if (error !== null && error !== undefined) {
        this.writing = false;
        this.failed = true;
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
