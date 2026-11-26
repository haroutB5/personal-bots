import { PersonalBotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { personalReadsTestLayer } from "../test/personalReadsTestLayer.ts";
import { seedV2Thread } from "../test/v2ProjectionSeed.ts";
import {
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL_ID,
  layerDisabled,
  MemoryEmbedder,
  type MemoryEmbedderShape,
} from "./MemoryEmbedder.ts";
import { RETRIEVAL_ENV } from "./memoryRetrieval.ts";
import {
  contentHash,
  MATCHED_BY_MEANING,
  MATCHED_WORDS_AND_MEANING,
  normalizeVector,
  SEMANTIC_MEMORY_ENV,
} from "./memorySemantic.ts";
import { layer as memoryLayer, PersonalMemoryService } from "./PersonalMemoryService.ts";

const BOT_A = PersonalBotId.make("bot-a");
const BOT_B = PersonalBotId.make("bot-b");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");

/**
 * Deterministic in-process semantic embedder with zero network calls.
 * Maps curated synonym clusters onto orthogonal concept axes so tests can
 * verify zero-keyword-overlap semantic recall, RRF fusion, and paraphrased
 * duplicate detection reliably.
 */
const TOPIC_AXES: ReadonlyArray<ReadonlyArray<string>> = [
  // Axis 0: coffee / cafe / London spots
  ["coffee", "cafe", "espresso", "latte", "soho", "fitzrovia", "london", "flat", "oat", "roastery"],
  // Axis 1: hardware / workstation
  ["laptop", "notebook", "workstation", "thinkpad", "macbook", "computer", "keyboard"],
  // Axis 2: dental / health appointments
  ["dentist", "dental", "teeth", "hygienist", "clinic", "checkup"],
  // Axis 3: travel / flights
  ["flight", "airport", "airline", "heathrow", "boarding", "luggage", "passport"],
];

function fakeEmbedText(text: string, dims: number = DEFAULT_EMBEDDING_DIMS): Float32Array {
  const vec = new Float32Array(dims);
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let matchedTopic = false;
  for (let axis = 0; axis < TOPIC_AXES.length; axis += 1) {
    const keywords = TOPIC_AXES[axis]!;
    let hits = 0;
    for (const w of words) {
      if (keywords.includes(w)) hits += 1;
    }
    if (hits > 0) {
      vec[axis] = hits;
      matchedTopic = true;
    }
  }
  if (!matchedTopic) {
    // Deterministic fallback hash onto higher dimensions so unrelated texts stay orthogonal.
    for (const w of words) {
      let h = 2166136261;
      for (let i = 0; i < w.length; i += 1) {
        h ^= w.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const bucket = 16 + (Math.abs(h) % (dims - 16));
      vec[bucket] = (vec[bucket] ?? 0) + 1;
    }
  }
  return normalizeVector(vec);
}

const makeFakeEmbedderLayer = (options?: { readonly failEmbed?: boolean }) =>
  Layer.succeed(MemoryEmbedder, {
    modelId: DEFAULT_EMBEDDING_MODEL_ID,
    dims: DEFAULT_EMBEDDING_DIMS,
    available: Effect.succeed(!options?.failEmbed),
    embed: (texts) =>
      options?.failEmbed
        ? Effect.succeed(null)
        : Effect.succeed(texts.map((text) => fakeEmbedText(text, DEFAULT_EMBEDDING_DIMS))),
  } satisfies MemoryEmbedderShape);

const makeTestLayer = (embedderLayer: Layer.Layer<MemoryEmbedder>) =>
  memoryLayer.pipe(
    Layer.provide(embedderLayer),
    Layer.provideMerge(personalReadsTestLayer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const seedBots = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  for (const [botId, threadId, team] of [
    [BOT_A, THREAD_A, "dev"],
    [BOT_B, THREAD_B, "ops"],
  ] as const) {
    yield* sql`
      INSERT INTO personal_bots (
        bot_id, name, description, instructions, avatar_shape, avatar_color,
        model_selection_json, enabled, sort_order, team, created_at, updated_at
      )
      VALUES (${botId}, ${botId}, '', '', 'blob', '#1A73E8', '{}', 1, 0, ${team}, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
      VALUES (${threadId}, ${botId}, ${now})
    `;
    yield* seedV2Thread({ threadId, createdAt: now });
  }
});

/** Waits briefly for async post-commit embedding rows to land in SQLite. */
const waitForEmbeddings = (
  expectedIds: ReadonlyArray<string>,
  expectedHashById?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const rows = yield* sql<{ readonly memoryId: string; readonly contentHash: string }>`
        SELECT memory_id AS "memoryId", content_hash AS "contentHash"
        FROM personal_memory_embeddings
        WHERE ${sql.in("memory_id", expectedIds)}
      `;
      const byId = new Map(rows.map((r) => [r.memoryId, r.contentHash] as const));
      const allReady = expectedIds.every((id) => {
        const hash = byId.get(id);
        if (hash === undefined) return false;
        if (expectedHashById?.[id] !== undefined) return hash === expectedHashById[id];
        return true;
      });
      if (allReady) return;
      yield* Effect.yieldNow;
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    }
    throw new Error(`Timed out waiting for embeddings: ${expectedIds.join(", ")}`);
  });

const withEnv = <A, E, R>(
  key: string,
  value: string | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }),
  );

describe("Phase 3: Hybrid semantic memory (FTS5 + embeddings + RRF)", () => {
  it.effect(
    "Migration 163 creates personal_memory_embeddings with model index and cascade delete",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* PersonalMemoryService;

        const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_personal_memory_embeddings_model'
      `;
        expect(indexes.map((i) => i.name)).toEqual(["idx_personal_memory_embeddings_model"]);

        const saved = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Favorite cafe in central London serves oat flat whites",
          source: "user",
        });
        yield* waitForEmbeddings([saved.memoryId]);

        const before = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM personal_memory_embeddings WHERE memory_id = ${saved.memoryId}
      `;
        expect(before[0]?.n).toBe(1);

        // Direct parent deletion cascades to personal_memory_embeddings
        yield* sql`DELETE FROM personal_memory WHERE memory_id = ${saved.memoryId}`;
        const after = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM personal_memory_embeddings WHERE memory_id = ${saved.memoryId}
      `;
        expect(after[0]?.n).toBe(0);
      }).pipe(Effect.provide(makeTestLayer(makeFakeEmbedderLayer()))),
  );

  it.effect("recalls notes with zero keyword overlap in search() and contextForThread()", () =>
    Effect.gen(function* () {
      yield* seedBots;
      const memory = yield* PersonalMemoryService;

      const cafe = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Favorite cafe in central London serves oat flat whites",
        source: "user",
      });
      const dentist = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Dentist checkup at dental clinic booked for Tuesday",
        source: "user",
      });
      yield* waitForEmbeddings([cafe.memoryId, dentist.memoryId]);

      // Zero shared keywords between "coffee place near Soho" and "Favorite cafe in central London..."
      const searchHits = yield* memory.search({
        query: "coffee place near Soho",
        botId: BOT_A,
      });
      expect(searchHits.map((e) => e.memoryId)).toEqual([cafe.memoryId]);

      const ctx = yield* memory.contextForThread({
        threadId: THREAD_A,
        query: "coffee place near Soho",
        record: false,
      });
      expect(ctx.block).not.toBeNull();
      expect(ctx.block).toContain("Favorite cafe in central London");
      expect(ctx.trace?.picked.find((p) => p.memoryId === cafe.memoryId)?.why).toContain(
        MATCHED_BY_MEANING,
      );

      // Query matching both keywords ("cafe") and meaning ("coffee") reports combined reason
      const hybridCtx = yield* memory.contextForThread({
        threadId: THREAD_A,
        query: "London cafe coffee recommendation",
        record: false,
      });
      expect(hybridCtx.trace?.picked.find((p) => p.memoryId === cafe.memoryId)?.why).toContain(
        MATCHED_WORDS_AND_MEANING,
      );
    }).pipe(Effect.provide(makeTestLayer(makeFakeEmbedderLayer()))),
  );

  it.effect("enforces strict bot and team scope isolation on semantic-only hits", () =>
    Effect.gen(function* () {
      yield* seedBots;
      const memory = yield* PersonalMemoryService;

      const botBPrivate = yield* memory.save({
        scope: "bot",
        scopeId: BOT_B,
        kind: "note",
        content: "Secret espresso roastery in Fitzrovia",
        source: "bot:bot-b;from=chat",
      });
      const opsTeam = yield* memory.save({
        scope: "team",
        scopeId: "ops",
        kind: "note",
        content: "Ops team latte spot near London bridge",
        source: "bot:bot-b;from=chat",
      });
      const shared = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Shared oat flat white cafe",
        source: "user",
      });
      yield* waitForEmbeddings([botBPrivate.memoryId, opsTeam.memoryId, shared.memoryId]);

      // BOT_A (team "dev") must ONLY see shared, never BOT_B private or ops team
      const botASearch = yield* memory.search({
        query: "coffee place near Soho",
        botId: BOT_A,
      });
      expect(botASearch.map((e) => e.memoryId)).toEqual([shared.memoryId]);

      const botACtx = yield* memory.contextForThread({
        threadId: THREAD_A,
        query: "coffee place near Soho",
        record: false,
      });
      expect(botACtx.block).toContain("Shared oat flat white cafe");
      expect(botACtx.block).not.toContain("Secret espresso roastery");
      expect(botACtx.block).not.toContain("Ops team latte spot");

      // BOT_B (team "ops") sees all three
      const botBSearch = yield* memory.search({
        query: "coffee place near Soho",
        botId: BOT_B,
      });
      expect(new Set(botBSearch.map((e) => e.memoryId))).toEqual(
        new Set([botBPrivate.memoryId, opsTeam.memoryId, shared.memoryId]),
      );
    }).pipe(Effect.provide(makeTestLayer(makeFakeEmbedderLayer()))),
  );

  it.effect("detects paraphrased duplicates in similar() via semantic cosine >= 0.72", () =>
    Effect.gen(function* () {
      yield* seedBots;
      const memory = yield* PersonalMemoryService;

      const existing = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Prefers espresso roastery in Fitzrovia",
        source: "user",
      });
      yield* waitForEmbeddings([existing.memoryId]);

      // Zero shared subject words with existing note, but same semantic topic
      const matches = yield* memory.similar({
        content: "Likes calm coffee cafe near Soho",
        botId: BOT_A,
      });
      expect(matches.length).toBeGreaterThanOrEqual(1);
      expect(matches[0]!.entry.memoryId).toBe(existing.memoryId);
      expect(matches[0]!.similarity).toBeGreaterThanOrEqual(0.72);
    }).pipe(Effect.provide(makeTestLayer(makeFakeEmbedderLayer()))),
  );

  it.effect(
    "invalidates and updates embeddings across forget, restore, replace, update, and remove",
    () =>
      Effect.gen(function* () {
        yield* seedBots;
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* PersonalMemoryService;

        const first = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Favorite cafe in central London",
          source: "user",
        });
        yield* waitForEmbeddings([first.memoryId]);

        // Update changes content_hash and moves semantic topic to dental
        const updated = yield* memory.update({
          memoryId: first.memoryId,
          content: "Dentist appointment at clinic on Friday",
        });
        yield* waitForEmbeddings([updated.memoryId], {
          [updated.memoryId]: contentHash("Dentist appointment at clinic on Friday"),
        });

        const coffeeAfterUpdate = yield* memory.search({
          query: "coffee near Soho",
          botId: BOT_A,
        });
        expect(coffeeAfterUpdate).toEqual([]);

        const dentalAfterUpdate = yield* memory.search({
          query: "teeth hygienist checkup",
          botId: BOT_A,
        });
        expect(dentalAfterUpdate.map((e) => e.memoryId)).toEqual([updated.memoryId]);

        // Forget evicts from semantic cache
        yield* memory.forget({ memoryId: updated.memoryId, actorBotId: BOT_A });
        const dentalAfterForget = yield* memory.search({
          query: "teeth hygienist checkup",
          botId: BOT_A,
        });
        expect(dentalAfterForget).toEqual([]);

        // Restore brings it back (give async re-hydration fiber a tick to repopulate in-memory cache)
        yield* memory.restore({ memoryId: updated.memoryId });
        yield* Effect.yieldNow;
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
        const dentalAfterRestore = yield* memory.search({
          query: "teeth hygienist checkup",
          botId: BOT_A,
        });
        expect(dentalAfterRestore.map((e) => e.memoryId)).toEqual([updated.memoryId]);

        // Replace supersedes old entry and indexes replacement
        const replacement = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "New dental clinic checkup moved to Monday",
          source: "user",
          replaces: [updated.memoryId],
        });
        yield* waitForEmbeddings([replacement.memoryId]);
        const afterReplace = yield* memory.search({
          query: "teeth hygienist",
          botId: BOT_A,
        });
        expect(afterReplace.map((e) => e.memoryId)).toEqual([replacement.memoryId]);

        // Remove evicts from cache AND deletes embedding row from SQLite
        yield* memory.remove({ memoryId: replacement.memoryId });
        const afterRemove = yield* memory.search({
          query: "teeth hygienist",
          botId: BOT_A,
        });
        expect(afterRemove).toEqual([]);
        const remainingRows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM personal_memory_embeddings WHERE memory_id = ${replacement.memoryId}
      `;
        expect(remainingRows[0]?.n).toBe(0);
      }).pipe(Effect.provide(makeTestLayer(makeFakeEmbedderLayer()))),
  );

  it.effect("honors T3CODE_PERSONAL_MEMORY_SEMANTIC=off and legacy retrieval kill switches", () =>
    Effect.gen(function* () {
      yield* seedBots;
      const memory = yield* PersonalMemoryService;

      const saved = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Favorite cafe in central London",
        source: "user",
      });
      yield* waitForEmbeddings([saved.memoryId]);

      // Semantic off: zero-keyword query returns empty, keyword query still works via FTS5
      const semOffZeroOverlap = yield* withEnv(
        SEMANTIC_MEMORY_ENV,
        "off",
        memory.search({ query: "coffee place near Soho", botId: BOT_A }),
      );
      expect(semOffZeroOverlap).toEqual([]);

      const semOffKeyword = yield* withEnv(
        SEMANTIC_MEMORY_ENV,
        "off",
        memory.search({ query: "central London cafe", botId: BOT_A }),
      );
      expect(semOffKeyword.map((e) => e.memoryId)).toEqual([saved.memoryId]);

      // Legacy retrieval bypasses semantic too
      const legacyZeroOverlap = yield* withEnv(
        RETRIEVAL_ENV,
        "legacy",
        memory.search({ query: "coffee place near Soho", botId: BOT_A }),
      );
      expect(legacyZeroOverlap).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(makeFakeEmbedderLayer()))),
  );

  it.effect("falls back cleanly to pure FTS5 when embedder is disabled or fails", () =>
    Effect.gen(function* () {
      yield* seedBots;
      const memory = yield* PersonalMemoryService;

      const saved = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Favorite cafe in central London",
        source: "user",
      });

      const zeroOverlap = yield* memory.search({
        query: "coffee place near Soho",
        botId: BOT_A,
      });
      expect(zeroOverlap).toEqual([]);

      const keywordHits = yield* memory.search({
        query: "central London cafe",
        botId: BOT_A,
      });
      expect(keywordHits.map((e) => e.memoryId)).toEqual([saved.memoryId]);

      const ctx = yield* memory.contextForThread({
        threadId: THREAD_A,
        query: "central London cafe",
        record: false,
      });
      expect(ctx.block).toContain("Favorite cafe in central London");
    }).pipe(Effect.provide(makeTestLayer(layerDisabled))),
  );
});
