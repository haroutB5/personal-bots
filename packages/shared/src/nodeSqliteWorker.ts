// @effect-diagnostics globalTimers:off -- startup/stop deadlines belong to the worker's own lifecycle.
/**
 * One serialized `node:sqlite` connection on a worker thread.
 *
 * The server's database used to run on the process's main thread, where every
 * `StatementSync.all/run` blocked the event loop for as long as the disk took
 * (one memory SELECT held it for 4.55 s). This module starts one worker that
 * owns one connection and answers requests strictly in arrival order, so the
 * main thread only pays message passing and result copying.
 *
 * The worker is intentionally synchronous: while a statement runs the worker
 * cannot read another message, which is what keeps ordering and whole
 * transactions intact. `T3CODE_SQLITE_WORKER=off` restores the in-thread path.
 */
import * as NodeWorkerThreads from "node:worker_threads";

export const SQLITE_WORKER_ENV = "T3CODE_SQLITE_WORKER";
export const SQLITE_WORKER_STARTUP_TIMEOUT_MS = 10_000;
export const SQLITE_WORKER_CLOSE_TIMEOUT_MS = 5_000;

/** `off` (and the usual off words) keeps every statement on the calling thread. */
export const sqliteWorkerEnabled = (value: string | undefined): boolean =>
  !["off", "0", "false", "no", "disabled"].includes(value?.trim().toLowerCase() ?? "");

export interface SqliteWorkerConnectOptions {
  readonly filename: string;
  readonly readonly: boolean;
  readonly allowExtension: boolean;
  readonly prepareCacheSize: number;
  readonly prepareCacheTtlMs: number;
}

/** `rows` = object rows, `values` = positional arrays, `raw` = the statement result. */
export type SqliteWorkerMode = "rows" | "values" | "raw";

export interface SqliteWorkerExecuteRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly mode: SqliteWorkerMode;
  readonly safeIntegers: boolean;
  readonly unprepared: boolean;
}

export interface SqliteWorkerFailurePayload {
  readonly operation: string;
  readonly message: string;
  readonly code?: string | number | undefined;
  readonly errcode?: number | undefined;
  readonly errstr?: string | undefined;
  readonly stack?: string | undefined;
}

/** A worker problem, carrying the SQLite error fields the classifier needs. */
export class SqliteWorkerFailure extends Error {
  readonly payload: SqliteWorkerFailurePayload;

  constructor(payload: SqliteWorkerFailurePayload) {
    super(payload.message);
    this.name = "SqliteWorkerFailure";
    this.payload = payload;
  }
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  abandoned: boolean;
}

type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly id: number; readonly rows: unknown }
  | { readonly type: "closed"; readonly id: number }
  | {
      readonly type: "failed";
      readonly id?: number | undefined;
      readonly operation: string;
      readonly error: SqliteWorkerFailurePayload;
    };

// Inline CommonJS source: it works in a bundled server, a test runner and a
// plain checkout without a second build artifact (same form as the checkpoint
// worker). It never writes application rows itself; it only runs what it is
// asked to run.
const SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const capacity = Math.max(1, Number(workerData.prepareCacheSize) || 200);
const ttlMs = Math.max(0, Number(workerData.prepareCacheTtlMs) || 0);
const statements = new Map();
const readerCache = new WeakMap();
let db;
let closed = false;

function failure(operation, error) {
  return {
    operation,
    message: String((error && error.message) || error),
    code: error && error.code,
    errcode: error && error.errcode,
    errstr: error && error.errstr,
    stack: error && error.stack,
  };
}

function post(message) {
  if (closed && message.type !== 'closed' && message.type !== 'failed') return;
  parentPort.postMessage(message);
}

// LRU with the same capacity/TTL as the old Effect cache. A failed prepare is
// never stored, so a missing schema or a lock does not stick.
function prepare(sql) {
  const now = Date.now();
  const cached = statements.get(sql);
  if (cached) {
    statements.delete(sql);
    if (now - cached.usedAt < ttlMs) {
      cached.usedAt = now;
      statements.set(sql, cached);
      return cached.statement;
    }
  }
  const statement = db.prepare(sql);
  if (statements.size >= capacity) {
    const oldest = statements.keys().next().value;
    statements.delete(oldest);
  }
  statements.set(sql, { statement, usedAt: now });
  return statement;
}

function hasRows(statement) {
  const cached = readerCache.get(statement);
  if (cached !== undefined) return cached;
  const value = statement.columns().length > 0;
  readerCache.set(statement, value);
  return value;
}

function execute(message) {
  const startedAt = performance.now();
  let statement;
  try {
    statement = message.unprepared ? db.prepare(message.sql) : prepare(message.sql);
  } catch (error) {
    post({ type: 'failed', id: message.id, operation: 'prepare', error: failure('prepare', error) });
    return;
  }
  try {
    statement.setReadBigInts(Boolean(message.safeIntegers));
    let rows;
    if (hasRows(statement)) {
      if (message.mode === 'values') {
        statement.setReturnArrays(true);
        try {
          rows = statement.all(...message.params);
        } finally {
          statement.setReturnArrays(false);
        }
      } else {
        rows = statement.all(...message.params);
      }
    } else {
      const result = statement.run(...message.params);
      rows = message.mode === 'raw' ? result : [];
    }
    post({ type: 'result', id: message.id, rows, durationMs: performance.now() - startedAt });
  } catch (error) {
    post({ type: 'failed', id: message.id, operation: 'execute', error: failure('execute', error) });
  }
}

try {
  db = new DatabaseSync(workerData.filename, {
    readOnly: Boolean(workerData.readOnly),
    allowExtension: Boolean(workerData.allowExtension),
  });
} catch (error) {
  parentPort.postMessage({ type: 'failed', operation: 'open', error: failure('open', error) });
  process.exit(0);
}

parentPort.on('message', (message) => {
  if (message.op === 'execute') {
    execute(message);
    return;
  }
  if (message.op === 'close') {
    if (closed) {
      post({ type: 'closed', id: message.id });
      return;
    }
    closed = true;
    try {
      db.close();
    } catch (error) {
      parentPort.postMessage({ type: 'failed', id: message.id, operation: 'close', error: failure('close', error) });
      parentPort.close();
      return;
    }
    parentPort.postMessage({ type: 'closed', id: message.id });
    parentPort.close();
  }
});

parentPort.postMessage({ type: 'ready' });
`;

/**
 * One worker and one connection, strictly FIFO. `send` never queues behind an
 * Effect fiber: the worker's own message queue is the queue, so a caller that
 * is interrupted cannot let a later statement overtake one already running.
 */
export class SqliteWorkerClient {
  private readonly pending = new Map<number, Pending>();
  private readonly readyPromise: Promise<void>;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: unknown) => void) | undefined;
  private nextId = 1;
  private state: "starting" | "ready" | "closing" | "closed" | "failed" = "starting";
  private failure: SqliteWorkerFailure | undefined;
  private readonly closeWaiters: Array<() => void> = [];
  private readonly worker: NodeWorkerThreads.Worker;

  private constructor(worker: NodeWorkerThreads.Worker) {
    this.worker = worker;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    worker.on("message", (message: WorkerMessage) => this.onMessage(message));
    worker.on("error", (error: Error) =>
      this.fail(
        new SqliteWorkerFailure({
          operation: "worker",
          message: `SQLite worker failed: ${error.message}`,
          stack: error.stack,
        }),
      ),
    );
    worker.on("exit", (code) => {
      if (this.state !== "closed" && this.state !== "closing") {
        this.fail(
          new SqliteWorkerFailure({
            operation: "worker",
            message: `SQLite worker exited (${code})${this.failure ? "" : " unexpectedly"}`,
          }),
        );
      }
    });
    // A forgotten worker must not hold the process open while it shuts down.
    worker.unref();
  }

  static async start(options: SqliteWorkerConnectOptions): Promise<SqliteWorkerClient> {
    const worker = new NodeWorkerThreads.Worker(SOURCE, {
      eval: true,
      workerData: {
        filename: options.filename,
        readOnly: options.readonly,
        allowExtension: options.allowExtension,
        prepareCacheSize: options.prepareCacheSize,
        prepareCacheTtlMs: options.prepareCacheTtlMs,
      },
    });
    const client = new SqliteWorkerClient(worker);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.readyPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new SqliteWorkerFailure({
                  operation: "open",
                  message: `SQLite worker did not start within ${SQLITE_WORKER_STARTUP_TIMEOUT_MS} ms`,
                }),
              ),
            SQLITE_WORKER_STARTUP_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
      return client;
    } catch (error) {
      client.dispose();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Queue one statement. The returned id lets an interrupted caller stop waiting. */
  send(request: SqliteWorkerExecuteRequest): {
    readonly id: number;
    readonly promise: Promise<unknown>;
  } {
    if (this.state !== "ready") {
      return {
        id: -1,
        promise: Promise.reject(
          this.failure ??
            new SqliteWorkerFailure({
              operation: "worker",
              message: `SQLite worker is ${this.state}`,
            }),
        ),
      };
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, abandoned: false });
    });
    try {
      this.worker.postMessage({ id, op: "execute", ...request });
    } catch (error) {
      this.pending.delete(id);
      return {
        id,
        promise: Promise.reject(
          error instanceof Error
            ? new SqliteWorkerFailure({
                operation: "worker",
                message: error.message,
                stack: error.stack,
              })
            : error,
        ),
      };
    }
    return { id, promise };
  }

  /**
   * Stop waiting for a response. The worker still runs the statement, and a
   * failure it reports later stays with this request instead of being mistaken
   * for a dead worker.
   */
  abandon(id: number): void {
    const pending = this.pending.get(id);
    if (pending !== undefined) pending.abandoned = true;
  }

  /** Close the connection after every request already queued. */
  close(): Promise<void> {
    if (this.state === "closed" || this.state === "failed") {
      this.state = "closed";
      return Promise.resolve();
    }
    if (this.state === "closing") {
      return new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    }
    this.state = "closing";
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.state = error === undefined ? "closed" : "failed";
        for (const waiter of this.closeWaiters.splice(0)) waiter();
        if (error === undefined) resolve();
        else reject(error);
      };
      const timer = setTimeout(() => {
        this.worker.terminate().catch(() => undefined);
        finish();
      }, SQLITE_WORKER_CLOSE_TIMEOUT_MS);
      timer.unref?.();
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: () => finish(),
        reject: (error) => finish(error),
        abandoned: false,
      });
      try {
        this.worker.postMessage({ id, op: "close" });
      } catch {
        finish();
      }
    });
  }

  /** Hard stop, used only when startup itself fails. */
  dispose(): void {
    this.fail(new SqliteWorkerFailure({ operation: "worker", message: "SQLite worker disposed" }));
    this.state = "closed";
    this.worker.terminate().catch(() => undefined);
  }

  private onMessage(message: WorkerMessage): void {
    if (message.type === "ready") {
      if (this.state === "starting") {
        this.state = "ready";
        this.readyResolve?.();
      }
      return;
    }
    if (message.type === "result") {
      const pending = this.pending.get(message.id);
      if (pending !== undefined) {
        this.pending.delete(message.id);
        if (!pending.abandoned) pending.resolve(message.rows);
      }
      return;
    }
    if (message.type === "closed") {
      const pending = this.pending.get(message.id);
      if (pending !== undefined) {
        this.pending.delete(message.id);
        if (!pending.abandoned) pending.resolve(undefined);
      }
      return;
    }
    const failure = new SqliteWorkerFailure(message.error);
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending !== undefined) {
        this.pending.delete(message.id);
        // A statement that failed after its caller stopped waiting says
        // nothing about the worker itself.
        if (!pending.abandoned) pending.reject(failure);
        return;
      }
    }
    this.fail(failure);
  }

  private fail(error: SqliteWorkerFailure): void {
    if (this.state === "failed" || this.state === "closed") return;
    this.state = "failed";
    this.failure = error;
    this.readyReject?.(error);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
    for (const waiter of this.closeWaiters.splice(0)) waiter();
  }
}
