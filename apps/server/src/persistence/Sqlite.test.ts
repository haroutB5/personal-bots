// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as SqlitePersistence from "./Sqlite.ts";

const workers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workers.push(this);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

it.effect("keeps writes moving past a 48 MiB WAL while a reader retains its snapshot", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-burst-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = SqlitePersistence.layerFromPath(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const checkpointWorker = workers.at(-1)!;
    yield* sql`CREATE TABLE burst_probe(id INTEGER PRIMARY KEY, payload BLOB)`;
    yield* sql`INSERT INTO burst_probe VALUES (1, NULL)`;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
      (database) => Effect.sync(() => database.close()),
    );
    reader.exec("BEGIN");
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 1);

    yield* sql.withTransaction(
      sql`INSERT INTO burst_probe VALUES (2, zeroblob(${48 * 1024 * 1024}))`,
    );
    const state = yield* Effect.callback<{
      readonly log: number;
      readonly checkpointed: number;
      readonly blocked: boolean;
    }>((resume) => {
      const onMessage = (message: {
        readonly type?: string;
        readonly log?: number;
        readonly checkpointed?: number;
        readonly blocked?: boolean;
      }) => {
        if (
          message.type === "checkpoint" &&
          typeof message.log === "number" &&
          message.log > 10_000 &&
          typeof message.checkpointed === "number" &&
          typeof message.blocked === "boolean"
        ) {
          checkpointWorker.off("message", onMessage);
          resume(
            Effect.succeed({
              log: message.log,
              checkpointed: message.checkpointed,
              blocked: message.blocked,
            }),
          );
        }
      };
      checkpointWorker.on("message", onMessage);
      checkpointWorker.ref();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      checkpointWorker.postMessage("barrier");
      return Effect.sync(() => checkpointWorker.off("message", onMessage));
    });
    assert.isBelow(state.checkpointed, state.log);
    assert.isFalse(state.blocked);

    yield* sql.withTransaction(sql`INSERT INTO burst_probe VALUES (3, NULL)`);
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 1);
    reader.exec("COMMIT");
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 3);
  }).pipe(
    Effect.scoped,
    Effect.provide(persistence),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

// Linux names an open, already-deleted file "<path> (deleted)" in /proc/self/fd.
// SQLite names its temp files "etilqs_*" and, without TMPDIR, puts them in
// /var/tmp while os.tmpdir() is /tmp, so match the name, not the directory.
const openDeletedTempFiles = () =>
  NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("/etilqs_") && target.endsWith(" (deleted)") ? [target] : [];
    } catch {
      return [];
    }
  });

it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "keeps a write transaction's statement journal off the temp directory",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-temp-"));
    const persistence = SqlitePersistence.layerFromPath(
      NodePath.join(tempDir, "state.sqlite"),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE journal_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      for (let id = 0; id < 64; id++) {
        yield* sql`INSERT INTO journal_probe VALUES (${id}, ${"x".repeat(4096)})`;
      }
      const before = new Set(openDeletedTempFiles());
      const opened = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A multi-row update can fail halfway, so SQLite journals every page
          // it changes, here well past the 64 KiB it holds in memory by default.
          yield* sql`UPDATE journal_probe SET payload = payload || 'y'`;
          return openDeletedTempFiles().filter((target) => !before.has(target));
        }),
      );
      assert.deepEqual(opened, []);
    }).pipe(
      Effect.provide(persistence),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it("syncs the WAL only at checkpoints unless the kill switch asks for FULL", () => {
  assert.strictEqual(SqlitePersistence.sqliteSynchronousFromEnv(undefined), "NORMAL");
  assert.strictEqual(SqlitePersistence.sqliteSynchronousFromEnv(""), "NORMAL");
  assert.strictEqual(SqlitePersistence.sqliteSynchronousFromEnv("normal"), "NORMAL");
  assert.strictEqual(SqlitePersistence.sqliteSynchronousFromEnv("full"), "FULL");
  assert.strictEqual(SqlitePersistence.sqliteSynchronousFromEnv(" FULL "), "FULL");
  assert.strictEqual(SqlitePersistence.sqliteSynchronousFromEnv("2"), "FULL");
});

const readSynchronous = (envValue: string | undefined) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-sync-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const previous = process.env.T3CODE_SQLITE_SYNCHRONOUS;
  if (envValue === undefined) delete process.env.T3CODE_SQLITE_SYNCHRONOUS;
  else process.env.T3CODE_SQLITE_SYNCHRONOUS = envValue;
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    return row!.synchronous;
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3CODE_SQLITE_SYNCHRONOUS;
        else process.env.T3CODE_SQLITE_SYNCHRONOUS = previous;
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );
};

it.effect("opens the server database with synchronous=NORMAL (1) by default", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* readSynchronous(undefined), 1);
  }),
);

it.effect("opens the server database with synchronous=FULL (2) when the kill switch is set", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* readSynchronous("full"), 2);
  }),
);

it("sizes the page cache at 64 MiB unless the kill switch or a valid size says otherwise", () => {
  assert.strictEqual(
    SqlitePersistence.sqliteCacheMbFromEnv(undefined),
    SqlitePersistence.SQLITE_CACHE_DEFAULT_MB,
  );
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv(""), 64);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv("off"), null);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv(" OFF "), null);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv("0"), null);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv("default"), null);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv("128"), 128);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv("1024"), 1024);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv("4096"), 64);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv("12.5"), 64);
  assert.strictEqual(SqlitePersistence.sqliteCacheMbFromEnv("lots"), 64);
});

const readCacheSize = (envValue: string | undefined) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-cache-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const previous = process.env.T3CODE_SQLITE_CACHE_MB;
  if (envValue === undefined) delete process.env.T3CODE_SQLITE_CACHE_MB;
  else process.env.T3CODE_SQLITE_CACHE_MB = envValue;
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly cache_size: number }>`PRAGMA cache_size`;
    return row!.cache_size;
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(
      Effect.sync(() => {
        if (previous === undefined) delete process.env.T3CODE_SQLITE_CACHE_MB;
        else process.env.T3CODE_SQLITE_CACHE_MB = previous;
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );
};

it.effect("opens the server database with a 64 MiB page cache by default", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* readCacheSize(undefined), -64 * 1024);
  }),
);

it.effect("keeps SQLite's default page cache (-2000) when the kill switch is set", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* readCacheSize("off"), -2000);
  }),
);
