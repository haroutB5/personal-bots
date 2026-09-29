import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { personalWorkingProgress } from "./workingProgress.ts";

const thread = (id: string) => ThreadId.make(id);

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const addThread = (id: string, status: string, userAt: string) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, latest_user_message_at)
        VALUES (${id}, 'project-1', ${id}, '2026-09-29T09:00:00.000Z', '2026-09-29T09:00:00.000Z', ${userAt})
      `;
      yield* sql`
        INSERT INTO projection_thread_sessions (thread_id, status, provider_name, active_turn_id, last_error, updated_at)
        VALUES (${id}, ${status}, 'claudeAgent', NULL, NULL, '2026-09-29T10:00:00.000Z')
      `;
    });
  const addReasoning = (id: string, messageId: string, text: string, at: string) =>
    sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${messageId}, ${id}, 'reasoning', ${text}, 0, ${at}, ${at})
    `;
  const addTool = (
    id: string,
    activityId: string,
    title: string | null,
    summary: string,
    at: string,
    seq: number,
  ) =>
    sql`
      INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
      VALUES (${activityId}, ${id}, NULL, 'tool', 'tool.started', ${summary},
        ${title === null ? "{}" : `{"title":"${title}","detail":"cat .env"}`}, ${seq}, ${at})
    `;
  return { sql, addThread, addReasoning, addTool };
});

it.effect("notes for working chats only, newest of thinking and tool title, this turn only", () =>
  Effect.gen(function* () {
    const { addThread, addReasoning, addTool, sql } = yield* seed;
    // Working: thinking summary, then a newer tool step; an older turn's thinking is ignored.
    yield* addThread("t-working", "running", "2026-09-29T10:00:00.000Z");
    yield* addReasoning("t-working", "r-old", "**Yesterday's plan**", "2026-09-29T09:30:00.000Z");
    yield* addReasoning(
      "t-working",
      "r-new",
      "**Reading the failing test**\n\nMore words.",
      "2026-09-29T10:00:02.000Z",
    );
    yield* addTool(
      "t-working",
      "a1",
      "Running tests",
      "Running tests started",
      "2026-09-29T10:00:09.000Z",
      5,
    );
    // Working, thinking only.
    yield* addThread("t-thinking", "running", "2026-09-29T10:00:00.000Z");
    yield* addReasoning("t-thinking", "r-1", "**Planning the fix**", "2026-09-29T10:00:03.000Z");
    // Working, tool title from the summary when the payload has none.
    yield* addThread("t-summary", "starting", "2026-09-29T10:00:00.000Z");
    yield* addTool(
      "t-summary",
      "a2",
      null,
      "Searching the repo started",
      "2026-09-29T10:00:04.000Z",
      1,
    );
    // Working but nothing said or done yet.
    yield* addThread("t-quiet", "running", "2026-09-29T10:00:00.000Z");
    // Idle chat with old thinking: no note outlives its turn.
    yield* addThread("t-idle", "ready", "2026-09-29T10:00:00.000Z");
    yield* addReasoning("t-idle", "r-idle", "**Finished thing**", "2026-09-29T10:00:05.000Z");

    const ids = ["t-working", "t-thinking", "t-summary", "t-quiet", "t-idle", "t-unknown"].map(
      thread,
    );
    const notes = yield* personalWorkingProgress(sql, ids);
    expect(Object.fromEntries(notes.map((entry) => [entry.threadId, entry.note]))).toEqual({
      "t-working": "Running tests",
      "t-thinking": "Planning the fix",
      "t-summary": "Searching the repo",
    });
    expect(yield* personalWorkingProgress(sql, [])).toEqual([]);

    // The tool's detail (a command, a path) never reaches the note.
    expect(notes.every((entry) => !entry.note.includes(".env"))).toBe(true);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
