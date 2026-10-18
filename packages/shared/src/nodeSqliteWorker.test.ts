import * as NodeTimersPromises from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./nodeSqliteClient.ts";
import {
  SQLITE_WORKER_ENV,
  SqliteWorkerClient,
  SqliteWorkerFailure,
  sqliteWorkerEnabled,
} from "./nodeSqliteWorker.ts";

const SLOW_SELECT = `
  WITH RECURSIVE cnt(x) AS (
    SELECT 1
    UNION ALL
    SELECT x + 1 FROM cnt WHERE x < 400000
  )
  SELECT sum(x) FROM cnt
`;

const realSleep = (ms: number) => Effect.promise(() => NodeTimersPromises.setTimeout(ms));

const tempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-worker-" });
  return path.join(directory, "state.sqlite");
});

const startClient = (filename: string) =>
  Effect.acquireRelease(
    Effect.promise(() =>
      SqliteWorkerClient.start({
        filename,
        readonly: false,
        allowExtension: false,
        prepareCacheSize: 200,
        prepareCacheTtlMs: 10 * 60_000,
      }),
    ),
    (client) => Effect.promise(() => client.close()),
  );

const sendRows = (client: SqliteWorkerClient, sql: string, params: ReadonlyArray<unknown> = []) =>
  client.send({ sql, params, mode: "rows", safeIntegers: false, unprepared: false })
    .promise as Promise<ReadonlyArray<Record<string, unknown>>>;

it.effect("treats the documented off words as the kill switch", () =>
  Effect.sync(() => {
    for (const value of ["off", "0", "false", "no", "disabled", " OFF "]) {
      assert.equal(sqliteWorkerEnabled(value), false, value);
    }
    for (const value of [undefined, "", "on", "1", "true", "yes"]) {
      assert.equal(sqliteWorkerEnabled(value), true, String(value));
    }
  }),
);

it.effect("runs statements in the order they were sent", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    const client = yield* startClient(filename);
    yield* Effect.promise(() =>
      sendRows(
        client,
        "CREATE TABLE ordered(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)",
      ),
    );

    // Sent synchronously, before any response is awaited: this is the bridge's FIFO.
    const inserts = Array.from(
      { length: 40 },
      (_, index) =>
        client.send({
          sql: "INSERT INTO ordered(value) VALUES (?)",
          params: [`v${index}`],
          mode: "rows",
          safeIntegers: false,
          unprepared: false,
        }).promise,
    );
    yield* Effect.promise(() => Promise.all(inserts));

    const rows = yield* Effect.promise(() =>
      sendRows(client, "SELECT value FROM ordered ORDER BY id"),
    );
    assert.deepEqual(
      rows.map((row) => row.value),
      Array.from({ length: 40 }, (_, index) => `v${index}`),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps the queue usable after an interrupted response is abandoned", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    const client = yield* startClient(filename);
    yield* Effect.promise(() => sendRows(client, "CREATE TABLE abandoned(value INTEGER NOT NULL)"));

    const slow = client.send({
      sql: SLOW_SELECT,
      params: [],
      mode: "rows",
      safeIntegers: false,
      unprepared: false,
    });
    // The caller no longer waits, as an interrupted Effect fiber would.
    client.abandon(slow.id);
    const insert = client.send({
      sql: "INSERT INTO abandoned(value) VALUES (42)",
      params: [],
      mode: "rows",
      safeIntegers: false,
      unprepared: false,
    });
    yield* Effect.promise(() => insert.promise);
    const rows = yield* Effect.promise(() => sendRows(client, "SELECT value FROM abandoned"));
    assert.deepEqual(rows, [{ value: 42 }]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a failure from an abandoned request does not fail the worker", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    const client = yield* startClient(filename);
    yield* Effect.promise(() =>
      sendRows(client, "CREATE TABLE abandoned_failure(value TEXT NOT NULL UNIQUE)"),
    );
    yield* Effect.promise(() =>
      sendRows(client, "INSERT INTO abandoned_failure(value) VALUES ('taken')"),
    );
    const duplicate = client.send({
      sql: "INSERT INTO abandoned_failure(value) VALUES ('taken')",
      params: [],
      mode: "rows",
      safeIntegers: false,
      unprepared: false,
    });
    client.abandon(duplicate.id);
    // Let the worker report the constraint failure it no longer owes anyone.
    yield* realSleep(20);
    const rows = yield* Effect.promise(() =>
      sendRows(client, "SELECT count(*) AS count FROM abandoned_failure"),
    );
    assert.deepEqual(rows, [{ count: 1 }]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("fails visibly once the worker is gone instead of retrying", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    const client = yield* Effect.promise(() =>
      SqliteWorkerClient.start({
        filename,
        readonly: false,
        allowExtension: false,
        prepareCacheSize: 200,
        prepareCacheTtlMs: 10 * 60_000,
      }),
    );
    client.dispose();
    const error = yield* Effect.promise(() =>
      client
        .send({
          sql: "SELECT 1",
          params: [],
          mode: "rows",
          safeIntegers: false,
          unprepared: false,
        })
        .promise.then(
          () => undefined,
          (cause: unknown) => cause,
        ),
    );
    assert.instanceOf(error, SqliteWorkerFailure);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps a transaction whole against a concurrent write", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)`;

      const inserted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO audit(value) VALUES ('a')`;
            yield* Deferred.succeed(inserted, undefined);
            yield* Deferred.await(release);
            yield* sql`INSERT INTO audit(value) VALUES ('b')`;
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(inserted);
      // This write has to queue behind the open transaction, not land inside it.
      const outside = yield* sql`INSERT INTO audit(value) VALUES ('c')`.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* realSleep(50);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(transaction);
      yield* Fiber.join(outside);

      const values = yield* sql<{ readonly value: string }>`
        SELECT value FROM audit ORDER BY id
      `.pipe(Effect.map((rows) => rows.map((row) => row.value)));
      assert.deepEqual(values, ["a", "b", "c"]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rolls back an interrupted transaction before the connection is reused", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE audit(value TEXT NOT NULL)`;
      const inserted = yield* Deferred.make<void>();
      const transaction = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO audit(value) VALUES ('partial')`;
            yield* Deferred.succeed(inserted, undefined);
            yield* sql.unsafe(SLOW_SELECT);
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(inserted);
      yield* realSleep(20);
      yield* Fiber.interrupt(transaction);

      assert.deepEqual(yield* sql`SELECT value FROM audit`, []);
      // A ROLLBACK left open would make this begin fail or nest.
      yield* sql.withTransaction(sql`INSERT INTO audit(value) VALUES ('after')`);
      const values = yield* sql<{ readonly value: string }>`SELECT value FROM audit`.pipe(
        Effect.map((rows) => rows.map((row) => row.value)),
      );
      assert.deepEqual(values, ["after"]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps constraint and BigInt behaviour through the worker", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;
      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const big = yield* sql<{ readonly value: bigint }>`SELECT 9007199254740993 AS value`.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
      );
      assert.equal(big[0]?.value, 9007199254740993n);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("T3CODE_SQLITE_WORKER=off builds the in-thread path", () => {
  const previous = process.env[SQLITE_WORKER_ENV];
  process.env[SQLITE_WORKER_ENV] = "off";
  return Effect.gen(function* () {
    const filename = yield* tempDatabase;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE offpath(value TEXT NOT NULL)`;
      yield* sql`INSERT INTO offpath VALUES ('inline')`;
      assert.deepEqual(yield* sql`SELECT value FROM offpath`, [{ value: "inline" }]);
    }).pipe(Effect.provide(SqliteClient.layer({ filename })));
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env[SQLITE_WORKER_ENV];
        else process.env[SQLITE_WORKER_ENV] = previous;
      }),
    ),
  );
});
