// --compact-db tests: a fixture statev2.sqlite with deleted rows (a freelist) and a message search index,
// driven through the real runner and a throwaway systemd unit. Nothing here touches the live hbots data.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { makeEnv, sleep } from "./env.mjs";

const TERMINAL = [
  "live_verified",
  "live_verified_doc_update_failed",
  "rolled_back",
  "rollback_failed",
  "failed",
];
const sha256 = (file) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

function makeChurnDb(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT)",
    );
    db.exec(
      "CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, body TEXT)",
    );
    db.exec("CREATE TABLE personal_memory (id TEXT PRIMARY KEY, body TEXT)");
    db.exec(
      "CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, payload_json TEXT)",
    );
    db.exec(
      "CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, streaming INTEGER NOT NULL, payload_json TEXT NOT NULL)",
    );
    db.exec(
      "CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(text, content = '', contentless_delete = 1, tokenize = 'trigram remove_diacritics 1')",
    );
    db.exec("CREATE TABLE churn (id INTEGER PRIMARY KEY, body BLOB)");
    const insert = db.prepare("INSERT INTO churn (body) VALUES (?)");
    db.exec("BEGIN");
    for (let i = 0; i < 6000; i++) insert.run(Buffer.alloc(4096, i & 255));
    db.exec("COMMIT");
    db.exec("DELETE FROM churn WHERE id % 4 != 0");
    db.prepare("INSERT INTO effect_sql_migrations VALUES (113, '2026-01-01T00:00:00Z', 'fixture_113')").run();
    for (let i = 0; i < 25; i++)
      db.prepare("INSERT INTO projection_thread_activities VALUES (?, 'x')").run(`a${i}`);
    for (let i = 0; i < 7; i++)
      db.prepare("INSERT INTO personal_memory VALUES (?, 'fixture')").run(`m${i}`);
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES ('t1', ?)").run(
      JSON.stringify({ lineage: { relationshipToParent: null } }),
    );
    const message = db.prepare(
      "INSERT INTO orchestration_v2_projection_messages VALUES (?, 't1', ?, 0, ?)",
    );
    message.run("m1", "assistant", JSON.stringify({ text: "needle from the assistant" }));
    message.run("m2", "user", JSON.stringify({ text: "needle from the user", createdBy: "user" }));
    message.run("m3", "system", JSON.stringify({ text: "needle from a system prompt" }));
    db.exec("PRAGMA optimize");
  } finally {
    db.close();
  }
}

async function compactEnv({ migrateTo = 114 } = {}) {
  const env = await makeEnv({ migrateTo });
  const statev2 = NodePath.join(env.home, "dev", "userdata", "statev2.sqlite");
  NodeFS.rmSync(statev2, { force: true });
  makeChurnDb(statev2);
  env.start();
  env.target();
  env.writePins();
  const prepared = env.runner("--prepare");
  NodeAssert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  return env;
}

async function waitResult(env, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const j = env.result();
      if (TERMINAL.includes(j.status) && j.mode === "run") {
        await sleep(600);
        return env.result();
      }
    } catch {}
    await sleep(300);
  }
  throw new Error("runner did not finish in time");
}

const fileOf = (env, name) => NodePath.join(env.home, "dev", "userdata", name);

NodeTest.test(
  "--compact-db shrinks the stopped statev2 database, keeps integrity and leaves state.sqlite untouched",
  async () => {
    const env = await compactEnv();
    try {
      const statev2 = fileOf(env, "statev2.sqlite");
      const statev1Hash = sha256(fileOf(env, "state.sqlite"));
      const beforeBytes = NodeFS.statSync(statev2).size;
      const launched = env.launch(null, ["--compact-db"]);
      NodeAssert.equal(launched.status, 0, launched.stdout + launched.stderr);
      const j = await waitResult(env);
      NodeAssert.equal(j.status, "live_verified", j.error);
      NodeAssert.equal(j.backupExit, 0);
      NodeAssert.equal(j.backupVerified, true);
      NodeAssert.equal(j.compact.flag, true);
      NodeAssert.equal(j.compact.database, "statev2.sqlite");
      NodeAssert.equal(j.compact.exit, 0);
      NodeAssert.equal(j.compact.ok, true);
      NodeAssert.equal(j.compact.check, "quick_check");
      NodeAssert.equal(j.compact.checkResult, "ok");
      NodeAssert.equal(typeof j.compact.seconds, "number");
      NodeAssert.ok(j.compact.seconds >= 0);
      NodeAssert.ok(j.compact.beforeBytes >= beforeBytes);
      NodeAssert.ok(
        j.compact.afterBytes < j.compact.beforeBytes / 2,
        `${j.compact.beforeBytes} -> ${j.compact.afterBytes}`,
      );
      NodeAssert.equal(NodeFS.statSync(statev2).size, j.compact.afterBytes);
      NodeAssert.equal(sha256(fileOf(env, "state.sqlite")), statev1Hash, "state.sqlite untouched");
      NodeAssert.ok(j.timings["backup.stopped-window"] >= j.compact.seconds);

      const db = new DatabaseSync(statev2, { readOnly: true });
      try {
        const one = (sql) => Object.values(db.prepare(sql).get())[0];
        NodeAssert.equal(Number(one("PRAGMA auto_vacuum")), 2);
        NodeAssert.ok(Number(one("PRAGMA freelist_count")) < Number(one("PRAGMA page_count")) * 0.01);
        const verdicts = db
          .prepare("PRAGMA integrity_check")
          .all()
          .map((row) => Object.values(row)[0]);
        NodeAssert.deepEqual(verdicts, ["ok"]);
        const hits = db
          .prepare(
            "SELECT rowid FROM orchestration_v2_message_search WHERE orchestration_v2_message_search MATCH 'needle' ORDER BY rowid",
          )
          .all()
          .map((row) => Number(row.rowid));
        NodeAssert.equal(hits.length, 2, "search index holds the assistant and user messages");
      } finally {
        db.close();
      }
    } finally {
      env.stop();
    }
  },
);

NodeTest.test("--compact-db skips with a reason when free disk is below the database plus 2 GB", async () => {
  const env = await compactEnv();
  try {
    env.overrides.HBOTS_RELEASE_TEST_COMPACT_FREE_BYTES = "1024";
    const statev2 = fileOf(env, "statev2.sqlite");
    const beforeHash = sha256(statev2);
    const launched = env.launch(null, ["--compact-db"]);
    NodeAssert.equal(launched.status, 0, launched.stdout + launched.stderr);
    const j = await waitResult(env);
    NodeAssert.equal(j.status, "live_verified", j.error);
    NodeAssert.equal(j.compact.skipped, true);
    NodeAssert.match(j.compact.reason, /not enough free disk for VACUUM/);
    NodeAssert.equal(j.compact.exit, undefined);
    NodeAssert.equal(j.compact.freeBytes, 1024);
    NodeAssert.ok(j.compact.neededBytes > j.compact.beforeBytes);
    NodeAssert.equal(sha256(statev2), beforeHash, "the database was not rewritten");
    NodeAssert.match(
      NodeFS.readFileSync(NodePath.join(env.home, "logs", `restart-${env.targetVersion}.log`), "utf8"),
      /compact skipped: .*not enough free disk/,
    );
  } finally {
    env.stop();
  }
});

NodeTest.test(
  "--compact-db restores the verified backup byte for byte when VACUUM fails, and the release continues",
  async () => {
    const env = await compactEnv();
    try {
      env.overrides.HBOTS_RELEASE_TEST_COMPACT_FAIL = "after-vacuum";
      const statev2 = fileOf(env, "statev2.sqlite");
      const launched = env.launch(null, ["--compact-db"]);
      NodeAssert.equal(launched.status, 0, launched.stdout + launched.stderr);
      const j = await waitResult(env);
      NodeAssert.equal(j.status, "live_verified", j.error);
      NodeAssert.equal(j.compact.ok, false);
      NodeAssert.notEqual(j.compact.exit, 0);
      NodeAssert.match(j.compact.error, /forced compact failure after VACUUM/);
      NodeAssert.equal(j.compact.restored, true);
      NodeAssert.equal(j.compact.restoreVerified, true);
      NodeAssert.equal(j.compact.restoreSha256, j.compact.backupSha256);
      NodeAssert.equal(sha256(statev2), j.compact.backupSha256);
      NodeAssert.equal(NodeFS.statSync(statev2).size, j.compact.restoreBytes);
      NodeAssert.ok(
        j.compact.afterVacuumBytes < j.compact.beforeBytes,
        "VACUUM ran before the forced failure",
      );
      const backupFile = NodePath.join(j.compact.backupPath, "statev2.sqlite");
      NodeAssert.equal(sha256(backupFile), j.compact.backupSha256, "the backup copy is unchanged");
    } finally {
      env.stop();
    }
  },
);

NodeTest.test("without --compact-db nothing runs and the database is not rewritten", async () => {
  const env = await compactEnv();
  try {
    const statev2 = fileOf(env, "statev2.sqlite");
    const beforeHash = sha256(statev2);
    const launched = env.launch(null);
    NodeAssert.equal(launched.status, 0, launched.stdout + launched.stderr);
    const j = await waitResult(env);
    NodeAssert.equal(j.status, "live_verified", j.error);
    NodeAssert.equal(j.backupExit, 0);
    NodeAssert.equal("compact" in j, false);
    NodeAssert.equal(sha256(statev2), beforeHash, "the database was not rewritten");
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(env.home, "tmp")), false);
    const log = NodeFS.readFileSync(
      NodePath.join(env.home, "logs", `restart-${env.targetVersion}.log`),
      "utf8",
    );
    NodeAssert.doesNotMatch(log, /compact/);
  } finally {
    env.stop();
  }
});

NodeTest.test("--dry-run with --compact-db plans the step and the forced backup", async () => {
  const env = await compactEnv();
  try {
    const r = env.runner("--dry-run", ["--compact-db"]);
    NodeAssert.equal(r.status, 0, r.stdout + r.stderr);
    const j = env.result("--dry-run");
    NodeAssert.equal(j.status, "dryrun_ok");
    NodeAssert.equal(j.backupSkipped, false);
    NodeAssert.match(j.backupDecision, /--compact-db/);
    NodeAssert.equal(j.compactPlan.database, "statev2.sqlite");
    NodeAssert.equal(j.compactPlan.ok, true);
    NodeAssert.ok(j.compactPlan.neededBytes > j.compactPlan.bytes);
    NodeAssert.ok(j.plan.rows.some(([label]) => /compact db:/.test(label)));
    NodeAssert.match(r.stdout, /Database compact planned: statev2\.sqlite/);
  } finally {
    env.stop();
  }
});

NodeTest.test("the runner-side compact helper never opens a database itself", () => {
  const src = NodeFS.readFileSync(
    NodePath.join(
      NodePath.dirname(new URL(import.meta.url).pathname),
      "..",
      "lib",
      "compact.mjs",
    ),
    "utf8",
  );
  NodeAssert.doesNotMatch(src, /node:sqlite|DatabaseSync|better-sqlite3/);
});

NodeTest.test("--compact-db forces the pre-restart backup when the migration level is unchanged", async () => {
  const env = await compactEnv({ migrateTo: 113 });
  try {
    const statev2 = fileOf(env, "statev2.sqlite");
    const beforeBytes = NodeFS.statSync(statev2).size;
    const launched = env.launch(null, ["--compact-db"]);
    NodeAssert.equal(launched.status, 0, launched.stdout + launched.stderr);
    const j = await waitResult(env);
    NodeAssert.equal(j.status, "live_verified", j.error);
    NodeAssert.equal(j.backupSkipped, false);
    NodeAssert.equal(j.backupExit, 0);
    NodeAssert.match(j.backupDecision, /--compact-db/);
    NodeAssert.equal(j.compact.exit, 0);
    NodeAssert.ok(j.compact.beforeBytes >= beforeBytes);
    NodeAssert.ok(j.compact.afterBytes < j.compact.beforeBytes);
  } finally {
    env.stop();
  }
});
