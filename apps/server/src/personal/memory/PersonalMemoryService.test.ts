// @effect-diagnostics preferSchemaOverJson:off - asserts the stored JSON column verbatim.
import { PersonalBotId, PersonalTaskId, ThreadId, type PersonalTask } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeSensitiveExposureStore, rootExposureKey } from "../browser/sensitiveExposureStore.ts";
import {
  buildMemoryMatchQuery,
  looksLikeSecret,
  PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT,
  PERSONAL_MEMORY_PREFERENCE_MAX_CHARS,
  PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES,
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
      memory.save({ scope, scopeId, kind: "note", content, source: "user" });
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
    expect(context.block).toMatch(
      /- \[task summary\] \[\d{4}-\d{2}-\d{2} · [0-9a-f-]{8}\] Task "Compare broadband deals"/,
    );

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

it.effect("a task turn gets no task summaries; a chat turn still does", () =>
  Effect.gen(function* () {
    yield* linkThread;
    const memory = yield* PersonalMemoryService;
    const now = yield* DateTime.now;
    // More summaries than one turn's limit, all matching better than the
    // preference and the note: a task turn must still see those two.
    for (let index = 1; index <= 9; index++) {
      const taskId = PersonalTaskId.make(`task-batch-${index}`);
      yield* memory.saveTaskSummary({
        taskId,
        rootTaskId: taskId,
        parentTaskId: null,
        botId: BOT_A,
        threadId: THREAD_A,
        title: `Benchmark batch ${index}`,
        objective: "Run the benchmark",
        acceptanceCriteria: "",
        expectedOutput: "",
        status: "completed",
        source: "delegation",
        idempotencyKey: `k-batch-${index}`,
        depth: 0,
        maxDepth: 2,
        maxChildren: 4,
        result: { summary: `Benchmark batch ${index} scored ${index * 10} on the benchmark.` },
        errorCategory: null,
        errorMessage: null,
        availableAt: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: now,
      });
    }
    yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "preference",
      content:
        "The user wants benchmark results reported as a table with the run date and machine name.",
      source: "user",
    });
    yield* memory.save({
      scope: "bot",
      scopeId: BOT_A,
      kind: "note",
      content: "Benchmark machines live in the lab on the second floor next to the printer room.",
      source: "user",
    });
    const query = "Run benchmark batch 2";

    const taskTurn = yield* memory.contextForThread({
      threadId: THREAD_A,
      query,
      record: false,
      excludeTaskSummaries: true,
    });
    expect(taskTurn.memoryIds.length).toBe(2);
    expect(taskTurn.block).toContain("Known facts (from memory)");
    expect(taskTurn.block).toMatch(
      /- \[preference\] \[\d{4}-\d{2}-\d{2} · [0-9a-f-]{8}\] The user wants benchmark results/,
    );
    expect(taskTurn.block).toMatch(
      /- \[note\] \[\d{4}-\d{2}-\d{2} · [0-9a-f-]{8}\] Benchmark machines live in the lab/,
    );
    expect(taskTurn.block).not.toContain("[task summary]");

    const chatTurn = yield* memory.contextForThread({ threadId: THREAD_A, query, record: false });
    // The preference always, the note, and task summaries up to their own
    // quota of 6 (of the 9 that match).
    expect(chatTurn.memoryIds.length).toBe(8);
    expect(chatTurn.block).toMatch(
      /- \[task summary\] \[\d{4}-\d{2}-\d{2} · [0-9a-f-]{8}\] Task "Benchmark batch/,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("a task turn with only task summaries to match gets no memory block", () =>
  Effect.gen(function* () {
    yield* linkThread;
    const memory = yield* PersonalMemoryService;
    const now = yield* DateTime.now;
    const taskId = PersonalTaskId.make("task-only");
    yield* memory.saveTaskSummary({
      taskId,
      rootTaskId: taskId,
      parentTaskId: null,
      botId: BOT_A,
      threadId: THREAD_A,
      title: "Benchmark batch 1",
      objective: "Run the benchmark",
      acceptanceCriteria: "",
      expectedOutput: "",
      status: "completed",
      source: "routine",
      idempotencyKey: "k-only",
      depth: 0,
      maxDepth: 2,
      maxChildren: 4,
      result: { summary: "Batch 1 scored 42." },
      errorCategory: null,
      errorMessage: null,
      availableAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
    });
    const taskTurn = yield* memory.contextForThread({
      threadId: THREAD_A,
      query: "Run benchmark batch 2",
      record: true,
      excludeTaskSummaries: true,
    });
    expect(taskTurn).toEqual({ block: null, memoryIds: [] });
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("a task tree that saw a sensitive site leaves no summary in bot memory", () =>
  Effect.gen(function* () {
    yield* linkThread;
    const memory = yield* PersonalMemoryService;
    const store = makeSensitiveExposureStore(yield* SqlClient.SqlClient);
    const now = yield* DateTime.now;
    const rootId = PersonalTaskId.make("task-root");
    const childId = PersonalTaskId.make("task-child");
    // The child read the bank; only the tree key carries it to the parent.
    yield* store.record([rootExposureKey(rootId)], "source", "https://bank.example");
    const task: PersonalTask = {
      taskId: childId,
      rootTaskId: rootId,
      parentTaskId: rootId,
      botId: BOT_A,
      threadId: THREAD_A,
      title: "Check my balance",
      objective: "Read the balance",
      acceptanceCriteria: "",
      expectedOutput: "",
      status: "completed",
      source: "user",
      idempotencyKey: "k-balance",
      depth: 1,
      maxDepth: 2,
      maxChildren: 4,
      result: { summary: "Current account balance is 1,234.56." },
      errorCategory: null,
      errorMessage: null,
      availableAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
    };
    yield* memory.saveTaskSummary(task);
    // Injected into every new chat of the bot, where nothing would be tainted.
    expect(yield* memory.list({ kind: "task_summary" })).toEqual([]);
  }).pipe(Effect.provide(TestLayer)),
);

/** Back-dates an entry so "newest first" and "weeks ago" are real in the test. */
const ageEntry = (memoryId: string, daysAgo: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const at = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: daysAgo }));
    yield* sql`
      UPDATE personal_memory SET created_at = ${at}, updated_at = ${at}
      WHERE memory_id = ${memoryId}
    `;
  });

describe("standing preferences", () => {
  it.effect(
    "every preference the bot can see is in every turn, relevant or not, newest first",
    () =>
      Effect.gen(function* () {
        yield* linkThread;
        const memory = yield* PersonalMemoryService;
        const old = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "preference",
          content: "Always deploy the latest builds without asking first.",
          source: "user",
        });
        yield* ageEntry(old.memoryId, 30);
        const own = yield* memory.save({
          scope: "bot",
          scopeId: BOT_A,
          kind: "preference",
          content: "Reply in short plain sentences, outcome first.",
          source: "user",
        });
        yield* ageEntry(own.memoryId, 2);
        yield* memory.save({
          scope: "bot",
          scopeId: BOT_B,
          kind: "preference",
          content: "Bot B keeps its own standing rule about invoices.",
          source: "user",
        });
        yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "The office printer is on the second floor.",
          source: "user",
        });

        // No word in common with any entry.
        for (const excludeTaskSummaries of [false, true]) {
          const context = yield* memory.contextForThread({
            threadId: THREAD_A,
            query: "What is the weather in Lisbon?",
            record: false,
            excludeTaskSummaries,
          });
          // Oldest first by when saved: the later-saved one wins a conflict.
          expect(context.memoryIds).toEqual([old.memoryId, own.memoryId]);
          expect(context.block).toMatch(
            /- \[preference\] \[\d{4}-\d{2}-\d{2} · [0-9a-f-]{8}\] Always deploy the latest builds/,
          );
          expect(context.block).toMatch(
            /- \[preference\] \[\d{4}-\d{2}-\d{2} · [0-9a-f-]{8}\] Reply in short plain sentences/,
          );
          expect(context.block).not.toContain("Bot B");
          expect(context.block).not.toContain("printer");
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a preference saved in two scopes appears once, and is never cut to 500 chars", () =>
    Effect.gen(function* () {
      yield* linkThread;
      const memory = yield* PersonalMemoryService;
      const long = `Release rule: ${"check the live version and the logs, ".repeat(30)}end.`;
      expect(long.length).toBeGreaterThan(600);
      yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "preference",
        content: long,
        source: "user",
      });
      yield* memory.save({
        scope: "bot",
        scopeId: BOT_A,
        kind: "preference",
        content: `  ${long.toUpperCase()}  `,
        source: "user",
      });
      const context = yield* memory.contextForThread({
        threadId: THREAD_A,
        query: "release rule",
        record: false,
      });
      expect(context.memoryIds.length).toBe(1);
      expect(context.block?.toLowerCase()).toContain("the logs, end.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preferences are capped by count, oldest dropped first", () =>
    Effect.gen(function* () {
      yield* linkThread;
      const memory = yield* PersonalMemoryService;
      for (let index = 0; index < PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES + 5; index++) {
        const entry = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "preference",
          content: `Standing rule number ${index}.`,
          source: "user",
        });
        // Rule 0 is the oldest.
        yield* ageEntry(entry.memoryId, 100 - index);
      }
      const context = yield* memory.contextForThread({
        threadId: THREAD_A,
        query: "anything",
        record: false,
      });
      expect(context.memoryIds.length).toBe(PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES);
      expect(context.block).toContain(
        `Standing rule number ${PERSONAL_MEMORY_PREFERENCE_MAX_ENTRIES + 4}.`,
      );
      expect(context.block).not.toContain("Standing rule number 4.");
      expect(context.block).toContain("Standing rule number 5.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preferences are capped by characters, oldest dropped first", () =>
    Effect.gen(function* () {
      yield* linkThread;
      const memory = yield* PersonalMemoryService;
      const count = Math.ceil(PERSONAL_MEMORY_PREFERENCE_MAX_CHARS / 1_900) + 3;
      for (let index = 0; index < count; index++) {
        const entry = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "preference",
          content: `Rule ${String(index).padStart(2, "0")}: ${"keep going ".repeat(170)}`,
          source: "user",
        });
        yield* ageEntry(entry.memoryId, 100 - index);
      }
      const context = yield* memory.contextForThread({
        threadId: THREAD_A,
        query: "anything",
        record: false,
      });
      const block = context.block ?? "";
      const included = context.memoryIds.length;
      expect(included).toBeLessThan(count);
      expect(included * 1_880).toBeLessThanOrEqual(PERSONAL_MEMORY_PREFERENCE_MAX_CHARS);
      expect(block).toContain(`Rule ${String(count - 1).padStart(2, "0")}:`);
      expect(block).not.toContain("Rule 00:");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("notes are relevance-picked with their own quota, weak matches dropped", () =>
    Effect.gen(function* () {
      yield* linkThread;
      const memory = yield* PersonalMemoryService;
      for (let index = 0; index < 25; index++) {
        yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: `Tomato bed ${index} was planted in spring.`,
          source: "user",
        });
      }
      yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "The office printer is on the second floor.",
        source: "user",
      });
      const context = yield* memory.contextForThread({
        threadId: THREAD_A,
        query: "How is the tomato bed?",
        record: false,
      });
      expect(PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT).toBe(6);
      expect(context.memoryIds.length).toBe(PERSONAL_MEMORY_CONTEXT_NOTE_LIMIT);
      expect(context.block).not.toContain("printer");
    }).pipe(Effect.provide(TestLayer)),
  );
});
