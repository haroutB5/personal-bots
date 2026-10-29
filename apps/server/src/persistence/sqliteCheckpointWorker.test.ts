// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- plain worker-thread tests, no Effect runtime involved
// @effect-diagnostics globalDate:off -- the same: these tests drive real threads and a real clock
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
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

/**
 * POSIX locks on the WAL-index file of `pid`, as `/proc/locks` shows them. A
 * connection that merely holds `state.sqlite` open keeps one (SQLite's
 * read-only WAL lock), and every process that reads or writes the database
 * takes its own.
 */
const walIndexLocks = (filename: string, pid: number): number => {
  const shm = NodeFS.statSync(`${filename}-shm`);
  const major = (Number(shm.dev) >> 8) & 0xfff;
  const minor = (Number(shm.dev) & 0xff) | ((Number(shm.dev) >> 12) & 0xfff00);
  const key = `${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${shm.ino}`;
  let held = 0;
  for (const line of NodeFS.readFileSync("/proc/locks", "utf8").split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length >= 6 && fields[4] === String(pid) && fields[5] === key) held += 1;
  }
  return held;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The 15-26 Oct SIGBUS crashes: the checkpoint worker read the wal-index
 * header by opening `state.sqlite-shm`. On Linux, closing any file descriptor
 * of a file drops *every* POSIX lock the process holds on it, so each tick
 * silently dropped the server's WAL-index locks; another process opening the
 * database then reinitialised the shared memory under the running server.
 * The worker must never open the shared-memory file or the database itself.
 */
it("never drops the writer's wal-index locks while looking at the WAL", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-worker-"));
  const filename = NodePath.join(root, "state.sqlite");
  const db = new NodeSqlite.DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE probe(id INTEGER PRIMARY KEY, payload BLOB)",
  );
  const worker = await startSqliteCheckpointWorker({
    filename,
    synchronous: "NORMAL",
    onFailure: () => assert.fail("worker failed"),
    onWarning: () => {},
  });
  try {
    // A short WAL: the worker still looks at the header on every tick, and
    // never reaches a checkpoint, so the connection stays idle between ticks.
    const put = db.prepare("INSERT INTO probe VALUES (?, randomblob(100))");
    for (let i = 1; i <= 20; i++) put.run(i);
    assert.isAtLeast(walIndexLocks(filename, process.pid), 1);
    // Two ticks with no statement in between: a lock dropped by a descriptor
    // close cannot come back on its own here.
    await sleep(2_500);
    assert.isAtLeast(
      walIndexLocks(filename, process.pid),
      1,
      "the worker dropped this process's wal-index locks",
    );
  } finally {
    await worker.stop();
    db.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A second process opening the database (what `t3 auth session issue`, `t3
 * pair` and every separate CLI invocation do) must not stop a server that is
 * writing and checkpointing. The child opens read-only, reads, closes, then
 * opens read-write, writes and checkpoints, like a CLI command that migrates
 * and records a row. The locks must be held in every sample of the run.
 */
it("survives a second process opening the database while it writes and checkpoints", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-worker-"));
  const filename = NodePath.join(root, "state.sqlite");
  const db = new NodeSqlite.DatabaseSync(filename);
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=4194304; CREATE TABLE probe(id INTEGER PRIMARY KEY, payload BLOB); CREATE TABLE cli(id INTEGER PRIMARY KEY, at TEXT)",
  );
  const worker = await startSqliteCheckpointWorker({
    filename,
    synchronous: "NORMAL",
    onFailure: () => assert.fail("worker failed"),
    onWarning: () => {},
  });
  const child = (readOnly: boolean) =>
    NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { DatabaseSync } from "node:sqlite";
        const db = new DatabaseSync(${JSON.stringify(filename)}, ${
          readOnly ? "{ readOnly: true }" : "{ timeout: 5000 }"
        });
        if (${readOnly}) {
          db.prepare("SELECT count(*) AS n FROM probe").get();
        } else {
          db.exec("INSERT INTO cli (at) VALUES ('" + new Date().toISOString() + "')");
          db.exec("PRAGMA wal_checkpoint(PASSIVE)");
        }
        db.close();
        `,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
  try {
    // Start with a WAL over the 1000-frame trigger so the worker checkpoints
    // again and again while the child keeps opening the file.
    db.exec(
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1500) INSERT INTO probe SELECT i,randomblob(4000) FROM n",
    );
    const put = db.prepare("INSERT INTO probe(payload) VALUES (randomblob(4000))");
    const samples: number[] = [];
    let children = 0;
    let readWrite = 0;
    const deadline = Date.now() + 60_000;
    for (let i = 1; Date.now() < deadline; i++) {
      put.run();
      if (i % 20 === 0) {
        const writes = children % 2 === 0;
        const result = child(!writes);
        assert.strictEqual(result.status, 0, result.stderr);
        children += 1;
        if (writes) readWrite += 1;
      }
      if (i % 5 === 0) samples.push(walIndexLocks(filename, process.pid));
      await sleep(20);
    }
    assert.isAbove(children, 100);
    assert.isAbove(samples.length, 500);
    assert.isAtLeast(Math.min(...samples), 1, "the wal-index locks were dropped during the run");
    // The writer is healthy: every commit and the child's rows are there.
    const rows = db.prepare("SELECT count(*) AS n FROM probe").get() as { n: number };
    assert.isAtLeast(rows.n, 1500);
    assert.isAtLeast(
      (db.prepare("SELECT count(*) AS n FROM cli").get() as { n: number }).n,
      readWrite,
    );
    db.prepare("SELECT count(*) AS n FROM probe").get();
  } finally {
    await worker.stop();
    db.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
