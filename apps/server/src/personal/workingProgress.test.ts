import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { PersonalEngine } from "./engine/PersonalEngine.ts";
import { personalReadsTestLayer, personalTestDatabase } from "./test/personalReadsTestLayer.ts";
import { personalWorkingProgress } from "./workingProgress.ts";

const testLayer = personalReadsTestLayer.pipe(Layer.provideMerge(personalTestDatabase));

const thread = (id: string) => ThreadId.make(id);

const threadPayload = (latestUserMessageAt: string) =>
  JSON.stringify({
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-test" },
    latestUserMessageAt,
  });

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* PersonalEngine;
  const addThread = (id: string, status: string, userAt: string) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
        VALUES (${id}, 'project-1', ${id}, 'claudeAgent', 'full-access', 'default', NULL,
          '2026-09-29T09:00:00.000Z', '2026-09-29T10:00:00.000Z', NULL, NULL,
          ${threadPayload(userAt)})
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
            completed_at, payload_json)
        VALUES (${`${id}-run`}, ${id}, 1, 'claudeAgent', NULL, ${status},
          '2026-09-29T10:00:00.000Z', NULL, '{}')
      `;
    });
  const addItem = (input: {
    id: string;
    threadId: string;
    ordinal: number;
    type: "reasoning" | "command_execution";
    text?: string;
    title?: string | null;
    at: string;
  }) =>
    sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${input.id}, ${input.threadId}, ${`${input.threadId}-run`}, NULL, NULL, NULL, NULL,
        ${input.ordinal}, ${input.type}, 'completed', ${input.at},
        ${JSON.stringify({
          type: input.type,
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.title === undefined ? {} : { title: input.title }),
        })})
    `;
  return { sql, engine, addThread, addItem };
});

it.effect("notes for working chats only, newest of thinking and tool title, this turn only", () =>
  Effect.gen(function* () {
    const { addThread, addItem, engine } = yield* seed;
    // Working: thinking summary, then a newer tool step; an older turn's thinking is ignored.
    yield* addThread("t-working", "running", "2026-09-29T10:00:00.000Z");
    yield* addItem({
      id: "r-old",
      threadId: "t-working",
      ordinal: 1,
      type: "reasoning",
      text: "**Yesterday's plan**",
      at: "2026-09-29T09:30:00.000Z",
    });
    yield* addItem({
      id: "r-new",
      threadId: "t-working",
      ordinal: 2,
      type: "reasoning",
      text: "**Reading the failing test**\n\nMore words.",
      at: "2026-09-29T10:00:02.000Z",
    });
    yield* addItem({
      id: "a1",
      threadId: "t-working",
      ordinal: 3,
      type: "command_execution",
      title: "Running tests",
      at: "2026-09-29T10:00:09.000Z",
    });
    // Working, thinking only.
    yield* addThread("t-thinking", "running", "2026-09-29T10:00:00.000Z");
    yield* addItem({
      id: "r-1",
      threadId: "t-thinking",
      ordinal: 1,
      type: "reasoning",
      text: "**Planning the fix**",
      at: "2026-09-29T10:00:03.000Z",
    });
    // Working, tool title from the step payload.
    yield* addThread("t-summary", "starting", "2026-09-29T10:00:00.000Z");
    yield* addItem({
      id: "a2",
      threadId: "t-summary",
      ordinal: 1,
      type: "command_execution",
      title: "Searching the repo",
      at: "2026-09-29T10:00:04.000Z",
    });
    // Working but nothing said or done yet.
    yield* addThread("t-quiet", "running", "2026-09-29T10:00:00.000Z");
    // Idle chat with old thinking: no note outlives its turn.
    yield* addThread("t-idle", "ready", "2026-09-29T10:00:00.000Z");
    yield* addItem({
      id: "r-idle",
      threadId: "t-idle",
      ordinal: 1,
      type: "reasoning",
      text: "**Finished thing**",
      at: "2026-09-29T10:00:05.000Z",
    });

    const ids = ["t-working", "t-thinking", "t-summary", "t-quiet", "t-idle", "t-unknown"].map(
      thread,
    );
    const notes = yield* personalWorkingProgress(engine, ids);
    expect(Object.fromEntries(notes.map((entry) => [entry.threadId, entry.note]))).toEqual({
      "t-working": "Running tests",
      "t-thinking": "Planning the fix",
      "t-summary": "Searching the repo",
    });
    expect(yield* personalWorkingProgress(engine, [])).toEqual([]);
    // A tool step in the turn says the bot is working, whichever note won.
    expect(Object.fromEntries(notes.map((entry) => [entry.threadId, entry.toolStep]))).toEqual({
      "t-working": true,
      "t-thinking": false,
      "t-summary": true,
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a turn the server starts on its own shows none of the previous turn's notes", () =>
  Effect.gen(function* () {
    const { addThread, addItem, sql, engine } = yield* seed;
    // One owner message at 10:00; turn-1 answered it and thought and ran a tool.
    yield* addThread("t-follow-up", "running", "2026-09-29T10:00:00.000Z");
    yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET status = 'completed', completed_at = '2026-09-29T10:00:10.000Z'
      WHERE run_id = 't-follow-up-run'
    `;
    yield* addItem({
      id: "r-1",
      threadId: "t-follow-up",
      ordinal: 1,
      type: "reasoning",
      text: "**Waiting for the child**",
      at: "2026-09-29T10:00:05.000Z",
    });
    yield* addItem({
      id: "a-1",
      threadId: "t-follow-up",
      ordinal: 2,
      type: "command_execution",
      title: "MCP tool call",
      at: "2026-09-29T10:00:09.000Z",
    });

    // While turn-1 runs, its note is named after turn-1.
    yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET status = 'running', completed_at = NULL
      WHERE run_id = 't-follow-up-run'
    `;
    const during = yield* personalWorkingProgress(engine, [thread("t-follow-up")]);
    expect(during).toEqual([
      { threadId: "t-follow-up", turnId: "t-follow-up-run", note: "MCP tool call", toolStep: true },
    ]);

    // The child finishes and the server starts turn-2 with no new owner message.
    yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET status = 'completed', completed_at = '2026-09-29T10:04:00.000Z'
      WHERE run_id = 't-follow-up-run'
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
          completed_at, payload_json)
      VALUES ('turn-2', 't-follow-up', 2, 'claudeAgent', NULL, 'running',
        '2026-09-29T10:05:00.000Z', NULL, ${JSON.stringify({ userMessageId: null })})
    `;
    // Nothing said yet in turn-2: no note, not turn-1's.
    expect(yield* personalWorkingProgress(engine, [thread("t-follow-up")])).toEqual([]);

    // Turn-2's first words name turn-2.
    yield* addItem({
      id: "r-2",
      threadId: "t-follow-up",
      ordinal: 3,
      type: "reasoning",
      text: "**Checking the child's result**",
      at: "2026-09-29T10:05:03.000Z",
    });
    expect(yield* personalWorkingProgress(engine, [thread("t-follow-up")])).toEqual([
      {
        threadId: "t-follow-up",
        turnId: "turn-2",
        note: "Checking the child's result",
        toolStep: false,
      },
    ]);
  }).pipe(Effect.provide(testLayer)),
);
