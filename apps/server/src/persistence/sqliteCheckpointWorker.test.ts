// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- plain worker-thread tests, no Effect runtime involved
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import {
  sqliteCheckpointWorkerEnabled,
  sqliteConcurrentCheckpointSafe,
  startSqliteCheckpointWorker,
  type SqliteCheckpointResult,
} from "./sqliteCheckpointWorker.ts";

it("supports the kill switch and refuses SQLite versions with the WAL-reset race", () => {
  assert.isTrue(sqliteCheckpointWorkerEnabled(undefined));
  for (const value of ["off", " OFF ", "0", "false", "no", "disabled"])
    assert.isFalse(sqliteCheckpointWorkerEnabled(value));
  for (const version of ["3.53.1", "3.51.3", "3.50.7", "3.44.6"])
    assert.isTrue(sqliteConcurrentCheckpointSafe(version));
  for (const version of ["3.51.2", "3.50.6", "3.49.9", "3.44.5", ""])
    assert.isFalse(sqliteConcurrentCheckpointSafe(version));
});

it("reports startup failure and can still be stopped", async () => {
  let failures = 0;
  const worker = await startSqliteCheckpointWorker({
    filename: NodePath.join(NodeOS.tmpdir(), "missing-checkpoint-parent", "state.sqlite"),
    synchronous: "NORMAL",
    onFailure: () => failures++,
    onWarning: () => {},
  });
  assert.isFalse(worker.active);
  assert.strictEqual(failures, 1);
  await worker.stop();
});

it("checkpoints independently, preserves a pinned reader and catches up after it ends", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-worker-"));
  const filename = NodePath.join(root, "state.sqlite");
  const db = new NodeSqlite.DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(id INTEGER PRIMARY KEY, payload BLOB)",
  );
  const reader = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  reader.exec("BEGIN");
  assert.strictEqual(reader.prepare("SELECT count(*) AS n FROM probe").get()!.n, 0);
  let resolveCheckpoint: ((value: SqliteCheckpointResult) => void) | undefined;
  const next = () =>
    new Promise<SqliteCheckpointResult>((resolve) => {
      resolveCheckpoint = resolve;
    });
  const worker = await startSqliteCheckpointWorker({
    filename,
    synchronous: "NORMAL",
    onFailure: () => assert.fail("worker failed"),
    onWarning: () => {},
    onCheckpoint: (result) => resolveCheckpoint?.(result),
  });
  try {
    db.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500) INSERT INTO probe SELECT i,randomblob(4000) FROM n",
    );
    const pinned = await next();
    assert.isAbove(pinned.log, pinned.checkpointed);
    assert.strictEqual(reader.prepare("SELECT count(*) AS n FROM probe").get()!.n, 0);
    reader.exec("COMMIT");
    const drained = await next();
    assert.strictEqual(drained.log, drained.checkpointed);
    assert.strictEqual(reader.prepare("SELECT count(*) AS n FROM probe").get()!.n, 1500);
    assert.isAbove(drained.ms, 0);
  } finally {
    await worker.stop();
    reader.close();
    db.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("leaves a short WAL alone so commits keep appending instead of restarting it", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-worker-"));
  const filename = NodePath.join(root, "state.sqlite");
  const db = new NodeSqlite.DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(id INTEGER PRIMARY KEY, payload BLOB)",
  );
  const checkpoints: SqliteCheckpointResult[] = [];
  const worker = await startSqliteCheckpointWorker({
    filename,
    synchronous: "NORMAL",
    onFailure: () => assert.fail("worker failed"),
    onWarning: () => {},
    onCheckpoint: (result) => checkpoints.push(result),
  });
  try {
    const put = db.prepare("INSERT INTO probe VALUES (?, randomblob(100))");
    for (let i = 1; i <= 40; i++) put.run(i);
    // Two worker ticks: a WAL far below 1000 frames must not be checkpointed,
    // or each following commit would restart the WAL and sync on this thread.
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    assert.deepStrictEqual(checkpoints, []);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM probe").get()!.n, 40);
  } finally {
    await worker.stop();
    db.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
