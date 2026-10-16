// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL } from "./taskChatAutoArchivePolicy.ts";

/**
 * The candidate SQL run against a real in-memory database, so the rule that a
 * delegated-task chat stays eligible when routine runs are posted into it later
 * (a release re-check routine) is proved by what the query returns, not by its
 * text.
 */
const SCHEMA = `
  CREATE TABLE personal_bots (bot_id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT);
  CREATE TABLE personal_bot_threads (
    thread_id TEXT PRIMARY KEY, bot_id TEXT, created_at TEXT,
    archived_at TEXT, auto_archived_at TEXT, last_viewed_at TEXT
  );
  CREATE TABLE projection_threads (
    thread_id TEXT PRIMARY KEY, title TEXT, archived_at TEXT, deleted_at TEXT,
    pinned_at TEXT, settled_override TEXT,
    pending_approval_count INTEGER, pending_user_input_count INTEGER
  );
  CREATE TABLE projection_thread_sessions (
    thread_id TEXT PRIMARY KEY, status TEXT, active_turn_id TEXT
  );
  CREATE TABLE personal_tasks (
    task_id TEXT PRIMARY KEY, thread_id TEXT, parent_task_id TEXT, source TEXT,
    status TEXT, created_at TEXT, completed_at TEXT, updated_at TEXT
  );
  CREATE TABLE projection_thread_messages (
    thread_id TEXT, created_at TEXT, role TEXT, message_id TEXT
  );
  CREATE TABLE personal_routines (thread_id TEXT PRIMARY KEY);
  CREATE TABLE personal_group_members (thread_id TEXT PRIMARY KEY);
`;

const CHAT_CREATED = "2026-10-11T09:00:00.000Z";
const ROUTINE_AT = "2026-10-11T11:00:00.000Z";

function makeDb(): NodeSqlite.DatabaseSync {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.prepare("INSERT INTO personal_bots (bot_id, name, deleted_at) VALUES (?, ?, NULL)").run(
    "bot-devops",
    "DevOps",
  );
  return db;
}

function addChat(db: NodeSqlite.DatabaseSync, threadId: string): void {
  db.prepare(
    `INSERT INTO personal_bot_threads
       (thread_id, bot_id, created_at, archived_at, auto_archived_at, last_viewed_at)
     VALUES (?, 'bot-devops', ?, NULL, NULL, NULL)`,
  ).run(threadId, CHAT_CREATED);
  db.prepare(
    `INSERT INTO projection_threads
       (thread_id, title, archived_at, deleted_at, pinned_at, settled_override,
        pending_approval_count, pending_user_input_count)
     VALUES (?, 'Prepare hbots 1.66.25', NULL, NULL, NULL, NULL, 0, 0)`,
  ).run(threadId);
  db.prepare(
    `INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id)
     VALUES (?, 'ready', NULL)`,
  ).run(threadId);
}

function addTask(
  db: NodeSqlite.DatabaseSync,
  task: {
    readonly taskId: string;
    readonly threadId: string;
    readonly source: string;
    readonly status: string;
    readonly createdAt?: string;
  },
): void {
  const at = task.createdAt ?? CHAT_CREATED;
  const completedAt = task.status === "running" ? null : at;
  db.prepare(
    `INSERT INTO personal_tasks
       (task_id, thread_id, parent_task_id, source, status, created_at, completed_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(task.taskId, task.threadId, task.source, task.status, at, completedAt, at);
}

function candidateThreadIds(db: NodeSqlite.DatabaseSync): ReadonlyArray<string> {
  const rows = db.prepare(TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL).all() as unknown as ReadonlyArray<{
    readonly threadId: string;
  }>;
  return rows.map((row) => row.threadId);
}

describe("TASK_CHAT_AUTO_ARCHIVE_CANDIDATES_SQL", () => {
  it("keeps a delegation chat as a candidate when routine runs land in it later", () => {
    const db = makeDb();
    addChat(db, "thread-release");
    addTask(db, {
      taskId: "task-delegation",
      threadId: "thread-release",
      source: "delegation",
      status: "completed",
    });
    // The release re-check routines the server posts into the same chat.
    addTask(db, {
      taskId: "task-routine-1",
      threadId: "thread-release",
      source: "routine",
      status: "completed",
      createdAt: ROUTINE_AT,
    });
    addTask(db, {
      taskId: "task-routine-2",
      threadId: "thread-release",
      source: "routine",
      status: "completed",
      createdAt: ROUTINE_AT,
    });

    expect(candidateThreadIds(db)).toEqual(["thread-release"]);
    db.close();
  });

  it("refuses it while one of those routine runs is still open", () => {
    const db = makeDb();
    addChat(db, "thread-release");
    addTask(db, {
      taskId: "task-delegation",
      threadId: "thread-release",
      source: "delegation",
      status: "completed",
    });
    addTask(db, {
      taskId: "task-routine-open",
      threadId: "thread-release",
      source: "routine",
      status: "running",
      createdAt: ROUTINE_AT,
    });

    expect(candidateThreadIds(db)).toEqual([]);
    db.close();
  });

  it("still excludes a chat that holds the owner's own task", () => {
    const db = makeDb();
    addChat(db, "thread-user");
    addTask(db, {
      taskId: "task-delegation",
      threadId: "thread-user",
      source: "delegation",
      status: "completed",
    });
    addTask(db, {
      taskId: "task-user",
      threadId: "thread-user",
      source: "user",
      status: "completed",
      createdAt: ROUTINE_AT,
    });

    expect(candidateThreadIds(db)).toEqual([]);
    db.close();
  });

  it("still refuses a chat whose delegated task has not finished", () => {
    const db = makeDb();
    addChat(db, "thread-release");
    addTask(db, {
      taskId: "task-delegation",
      threadId: "thread-release",
      source: "delegation",
      status: "running",
    });

    expect(candidateThreadIds(db)).toEqual([]);
    db.close();
  });
});
