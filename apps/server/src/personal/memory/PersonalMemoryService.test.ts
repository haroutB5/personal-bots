// @effect-diagnostics preferSchemaOverJson:off - asserts the stored JSON column verbatim.
import { PersonalBotId, PersonalTaskId, ThreadId, type PersonalTask } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  buildMemoryMatchQuery,
  looksLikeSecret,
  PersonalMemoryService,
  layer as memoryLayer,
} from "./PersonalMemoryService.ts";

const TestLayer = memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const BOT_A = PersonalBotId.make("bot-a");
const BOT_B = PersonalBotId.make("bot-b");
const THREAD_A = ThreadId.make("thread-a");

/** Links THREAD_A to BOT_A the way personal bot threads are stored. */
const linkThread = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const botId of [BOT_A, BOT_B]) {
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, created_at, updated_at
      )
      VALUES (${botId}, ${botId}, '', '', 'blob', '#1A73E8', '{}', 1, 0, ${now}, ${now})
    `;
  }
  yield* sql`
    INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
    VALUES (${THREAD_A}, ${BOT_A}, ${now})
  `;
});

describe("secret detection", () => {
  it.each([
    "my password is hunter2",
    "API key: sk-proj-abcdefghijklmnop1234567890",
    "token = ghp_abcdefghijklmnopqrstuvwxyz0123",
    "-----BEGIN RSA PRIVATE KEY-----",
    "AKIAABCDEFGHIJKLMNOP",
    "use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    "key 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928",
  ])("rejects %s", (text) => {
    expect(looksLikeSecret(text)).toBe(true);
  });

  it.each([
    "I prefer tea over coffee",
    "My dentist is on Tuesdays at 10:00",
    "Remember that the garden password reset is handled by Sam",
  ])("accepts %s", (text) => {
    expect(looksLikeSecret(text)).toBe(false);
  });
});

describe("match query", () => {
  it("quotes terms so FTS syntax in user text is inert", () => {
    expect(buildMemoryMatchQuery('what about "tea" OR NEAR(coffee')).toBe(
      '"about"* OR "tea" OR "near"* OR "coffee"*',
    );
    expect(buildMemoryMatchQuery("the and of")).toBeNull();
  });
});

it.effect("secret-like content is rejected and nothing is stored", () =>
  Effect.gen(function* () {
    const memory = yield* PersonalMemoryService;
    const error = yield* Effect.flip(
      memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "The wifi password is correct-horse-battery",
        source: "user",
      }),
    );
    expect(error.message).toContain("never stores secrets");
    expect(yield* memory.list({})).toEqual([]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("retrieval is scoped to shared + the thread's bot, ranked by relevance", () =>
  Effect.gen(function* () {
    yield* linkThread;
    const memory = yield* PersonalMemoryService;
    const save = (scope: "shared" | "bot", scopeId: string | null, content: string) =>
      memory.save({ scope, scopeId, kind: "preference", content, source: "user" });
    yield* save("shared", null, "The user grows tomatoes in the back garden.");
    yield* save("bot", BOT_A, "Bot A should water the tomatoes every morning.");
    yield* save("bot", BOT_B, "Bot B tracks tomatoes prices at the market.");
    yield* save("shared", null, "The user's favourite colour is green.");

    const context = yield* memory.contextForThread({
      threadId: THREAD_A,
      query: "How are my tomatoes doing?",
      record: true,
    });
    expect(context.memoryIds.length).toBe(2);
    expect(context.block).toContain("Known facts (from memory)");
    expect(context.block).toContain("back garden");
    expect(context.block).toContain("Bot A should water");
    expect(context.block).not.toContain("Bot B");
    expect(context.block).not.toContain("favourite colour");

    const sql = yield* SqlClient.SqlClient;
    const usage = yield* sql<{ readonly ids: string }>`
      SELECT memory_ids_json AS "ids" FROM personal_memory_usage WHERE thread_id = ${THREAD_A}
    `;
    expect(JSON.parse(usage[0]!.ids)).toEqual(context.memoryIds);

    // Ordinary T3 threads never get personal memory.
    const other = yield* memory.contextForThread({
      threadId: ThreadId.make("not-a-bot-thread"),
      query: "tomatoes",
      record: true,
    });
    expect(other).toEqual({ block: null, memoryIds: [] });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("a deleted entry is excluded from retrieval, search and list", () =>
  Effect.gen(function* () {
    yield* linkThread;
    const memory = yield* PersonalMemoryService;
    const entry = yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "note",
      content: "The user's cat is called Biscuit.",
      source: "user",
    });
    const before = yield* memory.contextForThread({
      threadId: THREAD_A,
      query: "what is the cat called",
      record: false,
    });
    expect(before.memoryIds).toEqual([entry.memoryId]);

    yield* memory.remove({ memoryId: entry.memoryId });

    const after = yield* memory.contextForThread({
      threadId: THREAD_A,
      query: "what is the cat called",
      record: false,
    });
    expect(after.memoryIds).toEqual([]);
    expect(yield* memory.search({ query: "Biscuit cat" })).toEqual([]);
    expect(yield* memory.list({})).toEqual([]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("task summaries are labelled, saved once per task and never resurrected", () =>
  Effect.gen(function* () {
    yield* linkThread;
    const memory = yield* PersonalMemoryService;
    const now = yield* DateTime.now;
    const taskId = PersonalTaskId.make("task-1");
    const task: PersonalTask = {
      taskId,
      rootTaskId: taskId,
      parentTaskId: null,
      botId: BOT_A,
      threadId: THREAD_A,
      title: "Compare broadband deals",
      objective: "Compare deals",
      acceptanceCriteria: "",
      expectedOutput: "",
      status: "completed",
      source: "user",
      idempotencyKey: "k1",
      depth: 0,
      maxDepth: 2,
      maxChildren: 4,
      result: { summary: "Cheapest fibre is Provider X at 30 a month." },
      errorCategory: null,
      errorMessage: null,
      availableAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
    };
    yield* memory.saveTaskSummary(task);
    yield* memory.saveTaskSummary(task);
    const summaries = yield* memory.list({ kind: "task_summary" });
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.source).toBe("task:task-1");

    const context = yield* memory.contextForThread({
      threadId: THREAD_A,
      query: "broadband fibre deals",
      record: false,
    });
    expect(context.block).toContain('- [task summary] Task "Compare broadband deals"');

    yield* memory.remove({ memoryId: summaries[0]!.memoryId });
    yield* memory.saveTaskSummary(task);
    expect(yield* memory.list({ kind: "task_summary" })).toEqual([]);

    // A running task, or a secret-looking reply, is never summarised.
    yield* memory.saveTaskSummary({
      ...task,
      taskId: PersonalTaskId.make("task-2"),
      result: { summary: "Your token: ghp_abcdefghijklmnopqrstuvwxyz0123" },
    });
    expect(yield* memory.list({ kind: "task_summary" })).toEqual([]);
  }).pipe(Effect.provide(TestLayer)),
);
