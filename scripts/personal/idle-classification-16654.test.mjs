// The release waiter's idle classifier, against a real SQLite file.
//
// Proves the 1.66.54 addition: an open voice call (a live
// `personal_voice_call_leases` row) holds the gate, while an expired or
// unreadable row does not, and a database that predates the table is read as
// idle rather than as an error. Run:
//   node --test scripts/personal/idle-classification-16654.test.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { activeLeaseCount, classify } from "./idle-classification-16654.mjs";

/** The tables the classifier reads, as the live database has them. */
const schema = (db) => {
  db.exec(`
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE projection_thread_sessions (thread_id TEXT, status TEXT, active_turn_id TEXT);
    CREATE TABLE personal_task_attempts (attempt_id TEXT PRIMARY KEY, ended_at TEXT);
    CREATE TABLE personal_tasks (
      task_id TEXT PRIMARY KEY, status TEXT, available_at TEXT,
      error_category TEXT, thread_id TEXT
    );
    CREATE TABLE provider_session_runtime (thread_id TEXT, status TEXT);
    CREATE TABLE personal_chat_resumes (thread_id TEXT, status TEXT, resume_at TEXT);
    CREATE TABLE projection_turns (
      thread_id TEXT, turn_id TEXT, state TEXT,
      checkpoint_turn_count INTEGER, requested_at TEXT
    );
  `);
};

const leases = (db) => {
  db.exec("CREATE TABLE personal_voice_call_leases (call_id TEXT PRIMARY KEY, expires_at TEXT)");
};

const at = (ms) => new Date(ms).toISOString();
const NOW = Date.parse("2026-10-15T18:00:00.000Z");

const freshDb = ({ withLeases = true, withSchema = true } = {}) => {
  const db = new DatabaseSync(":memory:");
  if (withSchema) schema(db);
  if (withLeases) leases(db);
  return db;
};

test("an empty database is idle, with no calls", () => {
  const db = freshDb();
  try {
    const verdict = classify(db, NOW);
    assert.equal(verdict.idle, true);
    assert.equal(verdict.calls, 0);
  } finally {
    db.close();
  }
});

test("a database older than the lease table is idle, never an error", () => {
  const db = freshDb({ withLeases: false });
  try {
    assert.equal(activeLeaseCount(db, NOW), 0);
    const verdict = classify(db, NOW);
    assert.equal(verdict.idle, true);
    assert.equal(verdict.calls, 0);
  } finally {
    db.close();
  }
});

test("an open call holds the release gate", () => {
  const db = freshDb();
  try {
    db.prepare("INSERT INTO personal_voice_call_leases VALUES (?, ?)").run(
      "call-1",
      at(NOW + 30 * 60_000),
    );
    const verdict = classify(db, NOW);
    assert.equal(verdict.idle, false);
    assert.equal(verdict.calls, 1);
    // The runner reads this line; the call count has to be on it.
    assert.match(
      `busy sessions=${verdict.sessions} attempts=${verdict.attempts} tasks=${verdict.blocking} calls=${verdict.calls} parked=${verdict.parked} resumes=${verdict.resumes} pending=${verdict.pendingFresh} stalePending=${verdict.pendingStale}`,
      /calls=1/,
    );
  } finally {
    db.close();
  }
});

test("a call close to its cap still counts: minutes left, not a horizon", () => {
  const db = freshDb();
  try {
    // A call that started 29 minutes ago has about six minutes of lease left;
    // `distant` (more than ten minutes away) would wrongly read it as free.
    db.prepare("INSERT INTO personal_voice_call_leases VALUES (?, ?)").run(
      "call-near-cap",
      at(NOW + 6 * 60_000),
    );
    assert.equal(activeLeaseCount(db, NOW), 1);
    assert.equal(classify(db, NOW).idle, false);
  } finally {
    db.close();
  }
});

test("only future, well-formed expiries count", () => {
  const db = freshDb();
  try {
    const insert = db.prepare("INSERT INTO personal_voice_call_leases VALUES (?, ?)");
    insert.run("call-expired", at(NOW - 60_000));
    assert.equal(activeLeaseCount(db, NOW), 0, "an expired row is a call that is over");
    insert.run("call-hand-edited", "not a timestamp");
    assert.equal(activeLeaseCount(db, NOW), 0, "an unreadable row never holds a release");
    insert.run("call-unpadded", "2026-10-15T18:05:00Z");
    assert.equal(activeLeaseCount(db, NOW), 0, "a non-canonical instant is not trusted");
    insert.run("call-open", at(NOW + 60_000));
    assert.equal(activeLeaseCount(db, NOW), 1);
    assert.equal(classify(db, NOW).idle, false, "one live call among dead rows is busy");
    db.prepare("DELETE FROM personal_voice_call_leases WHERE call_id = 'call-open'").run();
    assert.equal(classify(db, NOW).idle, true, "finishing the call frees the gate");
  } finally {
    db.close();
  }
});

test("the pre-existing busy reasons still hold", () => {
  const db = freshDb();
  try {
    db.exec(`
      INSERT INTO projection_threads VALUES ('live', NULL);
      INSERT INTO projection_thread_sessions VALUES ('live', 'running', NULL);
    `);
    const verdict = classify(db, NOW);
    assert.equal(verdict.sessions, 1);
    assert.equal(verdict.idle, false);
  } finally {
    db.close();
  }
});

function rateLimitedTask(db, input) {
  db.exec(`
    INSERT INTO projection_threads VALUES ('routine-live', NULL);
    INSERT INTO provider_session_runtime VALUES ('routine-live', 'ready');
  `);
  db.prepare("INSERT INTO projection_thread_sessions VALUES (?, ?, ?)").run(
    "routine-live",
    input.session ?? "ready",
    input.turn ?? null,
  );
  db.prepare("INSERT INTO personal_tasks VALUES (?, ?, ?, ?, ?)").run(
    "task-rate-limited",
    "rate_limited",
    input.availableAt,
    "rate_limited",
    "routine-live",
  );
}

test("a rate-limited routine parked far ahead or already overdue is not busy", () => {
  for (const availableAt of [at(NOW + 2 * 24 * 60 * 60_000), at(NOW - 50 * 60_000)]) {
    const db = freshDb();
    try {
      rateLimitedTask(db, { availableAt });
      const verdict = classify(db, NOW);
      assert.equal(verdict.blocking, 0, `parked retry ${availableAt}`);
      assert.equal(verdict.parked, 1);
      assert.equal(verdict.idle, true);
    } finally {
      db.close();
    }
  }
});

test("a retry due inside the landing window, or an active turn, still holds the gate", () => {
  const dueSoon = freshDb();
  try {
    rateLimitedTask(dueSoon, { availableAt: at(NOW + 5 * 60_000) });
    assert.equal(classify(dueSoon, NOW).idle, false);
  } finally {
    dueSoon.close();
  }
  const turning = freshDb();
  try {
    rateLimitedTask(turning, {
      availableAt: at(NOW + 2 * 24 * 60 * 60_000),
      turn: "turn-in-flight",
    });
    assert.equal(classify(turning, NOW).idle, false);
  } finally {
    turning.close();
  }
});
