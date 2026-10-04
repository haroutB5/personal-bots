// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  SqlitePersistenceMemory,
  WAL_SIZE_LIMIT_BYTES,
  makeSqlitePersistenceLive,
  sqliteSynchronousFromEnv,
} from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("shrinks the WAL file back to the size limit after a large write", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-wal-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const walFileSize = () => NodeFS.statSync(`${dbPath}-wal`).size;
  // About 25% more 4 KB rows than the limit holds, in one transaction.
  const rowCount = Math.ceil((WAL_SIZE_LIMIT_BYTES * 1.25) / 4000);

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE wal_probe(payload BLOB)`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rowCount})
      INSERT INTO wal_probe(payload) SELECT randomblob(4000) FROM n
    `;
    assert.isAbove(walFileSize(), WAL_SIZE_LIMIT_BYTES);

    // The auto-checkpoint after the large commit copied every frame into the
    // database, so the next commit restarts the WAL and cuts the file back.
    yield* sql`INSERT INTO wal_probe(payload) VALUES (x'00')`;
    assert.isAtMost(walFileSize(), WAL_SIZE_LIMIT_BYTES);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it("syncs the WAL only at checkpoints unless the kill switch asks for FULL", () => {
  assert.strictEqual(sqliteSynchronousFromEnv(undefined), "NORMAL");
  assert.strictEqual(sqliteSynchronousFromEnv(""), "NORMAL");
  assert.strictEqual(sqliteSynchronousFromEnv("normal"), "NORMAL");
  assert.strictEqual(sqliteSynchronousFromEnv("full"), "FULL");
  assert.strictEqual(sqliteSynchronousFromEnv(" FULL "), "FULL");
  assert.strictEqual(sqliteSynchronousFromEnv("2"), "FULL");
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
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
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
