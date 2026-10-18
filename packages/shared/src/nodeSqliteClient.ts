/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

import { noteSlowOp } from "./stallContext.ts";
import {
  SQLITE_WORKER_ENV,
  SqliteWorkerClient,
  SqliteWorkerFailure,
  sqliteWorkerEnabled,
  type SqliteWorkerExecuteRequest,
} from "./nodeSqliteWorker.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /**
   * Run SQL on one serialized worker thread (the default). `false` keeps the
   * statement on the calling thread, exactly as before the worker existed.
   * Unset reads `T3CODE_SQLITE_WORKER` once, at layer construction.
   */
  readonly worker?: boolean | undefined;
}

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

const STAGE_MESSAGES: Record<string, string> = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
  close: "Failed to close database",
  resetResultMode: "Failed to reset statement result mode",
  worker: "SQLite worker failed",
};

/**
 * Rebuild the SQLite error a worker reported with the same fields the
 * in-thread path classifies, so a constraint or lock keeps its typed reason.
 * The operation and message stay the ones the in-thread path used.
 */
const workerFailureToSqlError = (
  cause: unknown,
  fallbackMessage: string,
  fallbackOperation: string,
): SqlError => {
  if (!(cause instanceof SqliteWorkerFailure)) {
    return new SqlError({ reason: classifyError(cause, fallbackMessage, fallbackOperation) });
  }
  const { payload } = cause;
  const error = new Error(payload.message);
  if (payload.code !== undefined) Object.assign(error, { code: payload.code });
  if (payload.errcode !== undefined) Object.assign(error, { errcode: payload.errcode });
  if (payload.errstr !== undefined) Object.assign(error, { errstr: payload.errstr });
  if (payload.stack !== undefined) Object.assign(error, { stack: payload.stack });
  const operation = payload.operation || fallbackOperation;
  return new SqlError({
    reason: classifyError(error, STAGE_MESSAGES[operation] ?? fallbackMessage, operation),
  });
};

/**
 * Send one statement to the worker. Interrupting the fiber only stops waiting:
 * the worker still finishes the statement, so a following request keeps the
 * order the in-thread call would have had.
 */
const workerRequest = <A>(
  client: SqliteWorkerClient,
  request: SqliteWorkerExecuteRequest,
): Effect.Effect<A, SqlError> =>
  Effect.tryPromise({
    try: (signal) => {
      const pending = client.send(request);
      if (signal.aborted) client.abandon(pending.id);
      else signal.addEventListener("abort", () => client.abandon(pending.id), { once: true });
      return pending.promise as Promise<A>;
    },
    catch: (cause) => workerFailureToSqlError(cause, "Failed to execute statement", "execute"),
  });

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  // The pre-worker path, kept byte-for-byte in behaviour for the kill switch.
  const makeInlineConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
    });

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          // The call is synchronous, so its duration is how long it held the event loop.
          const startedAt = performance.now();
          if (hasRows(statement)) {
            const rows = statement.all(...(params as any));
            noteSlowOp("sql", startedAt, rows.length, () => statement.sourceSQL);
            return Effect.succeed(rows);
          }
          const result = statement.run(...(params as any));
          noteSlowOp("sql", startedAt, 0, () => statement.sourceSQL);
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to execute statement", "execute"),
            }),
          );
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));

    const runStatementValues = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(statement),
        (statement) =>
          Effect.try({
            try: () => {
              const startedAt = performance.now();
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                // Safe to cast to array after we've setReturnArrays(true)
                const rows = statement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
                noteSlowOp("sql", startedAt, rows.length, () => statement.sourceSQL);
                return rows;
              }
              statement.run(...(params as any));
              noteSlowOp("sql", startedAt, 0, () => statement.sourceSQL);
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
          }),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(
                  cause,
                  "Failed to reset statement result mode",
                  "resetResultMode",
                ),
              }),
          }).pipe(Effect.orDie),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
        runStatementValues(statement, params),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatementValues(statement, params ?? []),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [], false)),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const makeWorkerConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const client = yield* Effect.tryPromise({
      try: () =>
        SqliteWorkerClient.start({
          filename: options.filename,
          readonly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
          prepareCacheSize: options.prepareCacheSize ?? 200,
          prepareCacheTtlMs: Duration.toMillis(options.prepareCacheTTL ?? Duration.minutes(10)),
        }),
      catch: (cause) => workerFailureToSqlError(cause, "Failed to open database", "open"),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.tryPromise({
        try: () => client.close(),
        catch: (cause) => workerFailureToSqlError(cause, "Failed to close database", "close"),
      }).pipe(Effect.orDie),
    );

    const runOnWorker = (
      sql: string,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "values" | "raw",
      unprepared: boolean,
      safeIntegers: boolean,
    ) => {
      const startedAt = performance.now();
      return Effect.map(
        workerRequest<unknown>(client, { sql, params, mode, safeIntegers, unprepared }),
        (rows) => {
          // Round-trip time, not loop occupancy: the statement now runs on the
          // worker. Still useful when the stall recorder names a slow query.
          noteSlowOp("sql", startedAt, Array.isArray(rows) ? rows.length : 0, () => sql);
          return rows;
        },
      );
    };

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = Effect.withFiber<unknown, SqlError>((fiber) =>
          runOnWorker(
            sql,
            params,
            "rows",
            false,
            Boolean(Context.get(fiber.context, Client.SafeIntegers)),
          ),
        ).pipe(Effect.map((rows) => rows as ReadonlyArray<any>));
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return Effect.withFiber<unknown, SqlError>((fiber) =>
          runOnWorker(
            sql,
            params,
            "raw",
            false,
            Boolean(Context.get(fiber.context, Client.SafeIntegers)),
          ),
        );
      },
      executeValues(sql, params) {
        // The in-thread path never switched values results to BigInts.
        return runOnWorker(sql, params, "values", false, false) as Effect.Effect<
          ReadonlyArray<ReadonlyArray<unknown>>,
          SqlError
        >;
      },
      executeValuesUnprepared(sql, params) {
        return runOnWorker(sql, params ?? [], "values", true, false) as Effect.Effect<
          ReadonlyArray<ReadonlyArray<unknown>>,
          SqlError
        >;
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = Effect.withFiber<unknown, SqlError>((fiber) =>
          runOnWorker(
            sql,
            params ?? [],
            "rows",
            true,
            Boolean(Context.get(fiber.context, Client.SafeIntegers)),
          ),
        ).pipe(Effect.map((rows) => rows as ReadonlyArray<any>));
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const useWorker = options.worker ?? sqliteWorkerEnabled(process.env[SQLITE_WORKER_ENV]);
  const connection = yield* useWorker ? makeWorkerConnection : makeInlineConnection;

  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead, at the cost of serializing
    // read-only transactions behind other processes' writers. Read-only
    // connections cannot write, so they keep the deferred BEGIN.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
