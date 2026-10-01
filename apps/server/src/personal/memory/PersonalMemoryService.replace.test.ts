import { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { localDay } from "./memoryTidy.ts";
import { PersonalMemoryService, layer as memoryLayer } from "./PersonalMemoryService.ts";

const TestLayer = memoryLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const BOT_A = PersonalBotId.make("bot-a");
const BOT_B = PersonalBotId.make("bot-b");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

const linkThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const [botId, threadId] of [
    [BOT_A, THREAD_A],
    [BOT_B, THREAD_B],
  ] as const) {
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, created_at, updated_at
      )
      VALUES (${botId}, ${botId}, '', '', 'blob', '#1A73E8', '{}', 1, 0, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
      VALUES (${threadId}, ${botId}, ${now})
    `;
  }
});

const block = (threadId: ThreadId, query = "anything") =>
  Effect.flatMap(PersonalMemoryService, (memory) =>
    memory.contextForThread({ threadId, query, record: false }),
  ).pipe(Effect.map((context) => context.block ?? ""));

it.effect(
  "saving a changed fact with replaces supersedes the old one; only the new one loads",
  () =>
    Effect.gen(function* () {
      yield* linkThreads;
      const memory = yield* PersonalMemoryService;
      const old = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "preference",
        content: "Dev team models: Backend runs Claude Sonnet 5.5 high.",
        source: `bot:${BOT_A}`,
      });
      const changed = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "preference",
        content: "Dev team models: Backend runs Claude Opus 5.5 medium.",
        source: `bot:${BOT_A}`,
        replaces: [old.memoryId],
        actorBotId: BOT_A,
      });

      const text = yield* block(THREAD_A, "Dev team models Backend");
      expect(text).toContain("Opus 5.5 medium");
      expect(text).not.toContain("Sonnet 5.5 high");
      // Every bot stops getting it, not only the one that replaced it.
      expect(yield* block(THREAD_B, "Dev team models Backend")).not.toContain("Sonnet 5.5 high");
      expect((yield* memory.list({})).map((entry) => entry.memoryId)).toEqual([changed.memoryId]);
      expect(yield* memory.search({ query: "Sonnet Backend" })).toEqual([]);

      // Archived, not deleted: it keeps its text and says what replaced it.
      const archived = yield* memory.list({ status: "superseded" });
      expect(archived.map((entry) => entry.memoryId)).toEqual([old.memoryId]);
      expect(archived[0]!.content).toContain("Sonnet 5.5 high");
      expect(archived[0]!.supersededBy).toBe(changed.memoryId);
      expect(archived[0]!.supersededReason).toBe("Replaced by a newer save.");
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("saving the same text again with replaces archives the twin it names", () =>
  Effect.gen(function* () {
    yield* linkThreads;
    const memory = yield* PersonalMemoryService;
    const older = yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "note",
      content: "At most 5 bots run at once, per bot.",
      source: "user",
    });
    const input = {
      scope: "shared" as const,
      scopeId: null,
      kind: "note" as const,
      content: "At most 5 bots run at once in total, across all bots.",
      source: `bot:${BOT_A}`,
      actorBotId: BOT_A,
    };
    const first = yield* memory.save(input);
    // The bot sees the close match in the save result and calls again.
    const again = yield* memory.save({ ...input, replaces: [older.memoryId] });
    expect(again.memoryId).toBe(first.memoryId);
    expect((yield* memory.list({})).map((entry) => entry.memoryId)).toEqual([first.memoryId]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("restore brings a replaced entry back to every bot", () =>
  Effect.gen(function* () {
    yield* linkThreads;
    const memory = yield* PersonalMemoryService;
    const old = yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "preference",
      content: "Coin prices are quoted in USD.",
      source: "user",
    });
    yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "preference",
      content: "Coin prices are quoted in GBP.",
      source: "user",
      replaces: [old.memoryId],
    });
    expect(yield* block(THREAD_A)).not.toContain("USD");

    const restored = yield* memory.restore({ memoryId: old.memoryId });
    expect(restored.supersededAt).toBeNull();
    expect(yield* block(THREAD_A)).toContain("USD");
    expect(yield* memory.list({ status: "superseded" })).toEqual([]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "a bot cannot replace another bot's private entry, and a private save cannot hide a shared one",
  () =>
    Effect.gen(function* () {
      yield* linkThreads;
      const memory = yield* PersonalMemoryService;
      const privateB = yield* memory.save({
        scope: "bot",
        scopeId: BOT_B,
        kind: "preference",
        content: "Bot B reports crypto totals in GBP.",
        source: `bot:${BOT_B}`,
      });
      const shared = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "preference",
        content: "Reports use plain English.",
        source: "user",
      });

      const crossBot = yield* Effect.flip(
        memory.save({
          scope: "shared",
          scopeId: null,
          kind: "preference",
          content: "Crypto totals are in USD.",
          source: `bot:${BOT_A}`,
          replaces: [privateB.memoryId],
          actorBotId: BOT_A,
        }),
      );
      expect(crossBot.message).toContain("was not found");

      const hidesShared = yield* Effect.flip(
        memory.save({
          scope: "bot",
          scopeId: BOT_A,
          kind: "preference",
          content: "Reports use bullet points.",
          source: `bot:${BOT_A}`,
          replaces: [shared.memoryId],
          actorBotId: BOT_A,
        }),
      );
      expect(hidesShared.message).toContain("cannot replace a shared one");

      // Nothing was saved and nothing was archived.
      expect((yield* memory.list({})).map((entry) => entry.content).toSorted()).toEqual([
        "Bot B reports crypto totals in GBP.",
        "Reports use plain English.",
      ]);
      expect(yield* block(THREAD_B, "crypto totals")).toContain(
        "Bot B reports crypto totals in GBP.",
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("each entry in a turn's memory block shows its date", () =>
  Effect.gen(function* () {
    yield* linkThreads;
    const memory = yield* PersonalMemoryService;
    const entry = yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "preference",
      content: "Releases are confirmed five minutes after the restart.",
      source: "user",
    });
    const day = localDay(DateTime.toEpochMillis(entry.updatedAt));
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(yield* block(THREAD_A)).toContain(
      `- [preference] [${day}] Releases are confirmed five minutes after the restart.`,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("similar lists close entries the bot can see, never another bot's", () =>
  Effect.gen(function* () {
    yield* linkThreads;
    const memory = yield* PersonalMemoryService;
    const shared = yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "note",
      content: "Dev team models: QA and DevOps run GPT-6.1 Sol high; Backend runs Opus 5.5.",
      source: "user",
    });
    yield* memory.save({
      scope: "bot",
      scopeId: BOT_B,
      kind: "note",
      content: "Dev team models: QA and DevOps run GPT-6.1 Sol medium.",
      source: `bot:${BOT_B}`,
    });
    yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "note",
      content: "Harout's favourite drink is green tea.",
      source: "user",
    });
    const matches = yield* memory.similar({
      content:
        "Dev team models (2 Oct): QA and DevOps run GPT-6.1 Sol high; Backend runs Opus 5.5 high.",
      botId: BOT_A,
    });
    expect(matches.map((match) => match.entry.memoryId)).toEqual([shared.memoryId]);
  }).pipe(Effect.provide(TestLayer)),
);
