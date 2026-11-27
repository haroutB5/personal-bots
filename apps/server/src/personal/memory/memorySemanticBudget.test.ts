// Round-1 review fixes for hybrid semantic memory (hbots 1.67.62):
// M1 query-time embed budget, S1 degraded cooldown, S2 ONNX thread cap.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { personalReadsTestLayer } from "../test/personalReadsTestLayer.ts";
import {
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDER_DEGRADED_COOLDOWN_MS,
  layerWorker,
  MemoryEmbedder,
  type MemoryEmbedderShape,
} from "./MemoryEmbedder.ts";
import {
  makeMemoryEmbeddingStore,
  MAX_CACHED_VECTORS,
  QUERY_EMBED_TIMEOUT_MS,
} from "./memoryEmbeddingStore.ts";
import {
  EMBEDDING_INTER_OP_THREADS,
  EMBEDDING_INTRA_OP_THREADS,
  embeddingPipelineOptions,
} from "./memoryEmbeddingSessionOptions.ts";
import { normalizeVector } from "./memorySemantic.ts";
import { layer as memoryLayer, PersonalMemoryService } from "./PersonalMemoryService.ts";

const unitVector = (): Float32Array => {
  const vec = new Float32Array(DEFAULT_EMBEDDING_DIMS);
  vec[0] = 1;
  return normalizeVector(vec);
};

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/** Embedder whose query embeds can be switched to hang for `hangMs` (cold worker). */
const makeControllableEmbedder = () => {
  const state = {
    hangMs: 0,
    started: 0,
    completed: 0,
    interrupted: 0,
  };
  const shape: MemoryEmbedderShape = {
    modelId: DEFAULT_EMBEDDING_MODEL_ID,
    dims: DEFAULT_EMBEDDING_DIMS,
    available: Effect.succeed(true),
    embed: (texts) => {
      const hangMs = state.hangMs;
      if (hangMs === 0) return Effect.succeed(texts.map(() => unitVector()));
      return Effect.gen(function* () {
        state.started += 1;
        yield* sleep(hangMs);
        state.completed += 1;
        return texts.map(() => unitVector());
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => void (state.interrupted += 1))));
    },
  };
  return { state, layer: Layer.succeed(MemoryEmbedder, shape) };
};

describe("M1: query-time semantic embed is bounded", () => {
  it("defaults the budget to 2500 ms", () => {
    expect(QUERY_EMBED_TIMEOUT_MS).toBe(2_500);
  });

  it.live(
    "a hanging embedder makes searchSemantic return [] within the budget and stays available",
    () => {
      const embedder = makeControllableEmbedder();
      const testLayer = memoryLayer.pipe(
        Layer.provideMerge(embedder.layer),
        Layer.provideMerge(personalReadsTestLayer),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      );
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* PersonalMemoryService;
        const saved = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: "Favorite cafe in central London serves oat flat whites",
          source: "user",
        });
        // Wait for the post-commit embedding row.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const rows = yield* sql<{ readonly n: number }>`
            SELECT COUNT(*) AS "n" FROM personal_memory_embeddings WHERE memory_id = ${saved.memoryId}
          `;
          if ((rows[0]?.n ?? 0) > 0) break;
          yield* sleep(10);
        }

        const budgetMs = 100;
        const hangMs = 600;
        const store = yield* makeMemoryEmbeddingStore(sql, { queryEmbedTimeoutMs: budgetMs });

        // Warm path still returns semantic hits.
        const warm = yield* store.searchSemantic("coffee", { limit: 5, minCosine: 0.5 });
        expect(warm.map((hit) => hit.memoryId)).toEqual([saved.memoryId]);

        // Cold worker: the embed hangs far beyond the budget.
        embedder.state.hangMs = hangMs;
        const startedAt = Date.now();
        const cold = yield* store.searchSemantic("coffee", { limit: 5, minCosine: 0.5 });
        const elapsed = Date.now() - startedAt;
        expect(cold).toEqual([]);
        expect(elapsed).toBeGreaterThanOrEqual(budgetMs - 10);
        expect(elapsed).toBeLessThan(hangMs - 100);
        expect(embedder.state.started).toBe(1);

        // Not degraded: the embedder is still available.
        const shape = yield* MemoryEmbedder;
        expect(yield* shape.available).toBe(true);

        // The in-flight embed is not interrupted; it finishes (warming the model).
        yield* sleep(hangMs + 100);
        expect(embedder.state.completed).toBe(1);
        expect(embedder.state.interrupted).toBe(0);

        // Once warm again, semantic search works normally.
        embedder.state.hangMs = 0;
        const again = yield* store.searchSemantic("coffee", { limit: 5, minCosine: 0.5 });
        expect(again.map((hit) => hit.memoryId)).toEqual([saved.memoryId]);
      }).pipe(Effect.provide(testLayer));
    },
  );
});

describe("S1: degraded embedder retries after a cooldown", () => {
  it("defaults the cooldown to 10 minutes", () => {
    expect(EMBEDDER_DEGRADED_COOLDOWN_MS).toBe(10 * 60_000);
  });

  it.effect("a failed embed disables semantic search only until the cooldown ends", () => {
    const calls = { embed: 0 };
    let fail = true;
    const cooldownMs = 1_000;
    const layer = layerWorker({
      degradedCooldownMs: cooldownMs,
      createClient: () => ({
        embed: async (texts) => {
          calls.embed += 1;
          if (fail) throw new Error("worker cold-start timeout");
          return texts.map(() => unitVector());
        },
        dispose: async () => undefined,
      }),
    });
    return Effect.gen(function* () {
      const embedder = yield* MemoryEmbedder;
      expect(yield* embedder.available).toBe(true);

      expect(yield* embedder.embed(["hello"])).toBeNull();
      expect(calls.embed).toBe(1);
      expect(yield* embedder.available).toBe(false);

      // During the cooldown no worker call is made.
      fail = false;
      expect(yield* embedder.embed(["hello"])).toBeNull();
      expect(calls.embed).toBe(1);
      yield* TestClock.adjust(cooldownMs - 1);
      expect(yield* embedder.available).toBe(false);

      // After the cooldown the embedder recovers on its own.
      yield* TestClock.adjust(1);
      expect(yield* embedder.available).toBe(true);
      const vectors = yield* embedder.embed(["hello"]);
      expect(vectors?.length).toBe(1);
      expect(calls.embed).toBe(2);
      expect(yield* embedder.available).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});

describe("S2: ONNX session thread cap", () => {
  it("caps intra-op threads at 2 and inter-op at 1 on CPU q8", () => {
    expect(EMBEDDING_INTRA_OP_THREADS).toBe(2);
    expect(EMBEDDING_INTER_OP_THREADS).toBe(1);
    expect(embeddingPipelineOptions()).toEqual({
      dtype: "q8",
      device: "cpu",
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    });
  });
});

describe("Vector cache cap & single WARN", () => {
  it("defaults MAX_CACHED_VECTORS to 20_000", () => {
    expect(MAX_CACHED_VECTORS).toBe(20_000);
  });

  it.live("caps cached vectors to newest entries and logs a single WARN", () => {
    const warnings: Array<string> = [];
    const captureLogger = Logger.make(({ message }) => {
      warnings.push(String(message));
    });
    const embedder = makeControllableEmbedder();
    const testLayer = memoryLayer.pipe(
      Layer.provideMerge(embedder.layer),
      Layer.provideMerge(personalReadsTestLayer),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provideMerge(Logger.layer([captureLogger])),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const memory = yield* PersonalMemoryService;
      const savedIds: Array<string> = [];
      for (let i = 1; i <= 5; i += 1) {
        const saved = yield* memory.save({
          scope: "shared",
          scopeId: null,
          kind: "note",
          content: `Vector cache entry number ${i}`,
          source: "user",
        });
        savedIds.push(saved.memoryId);
      }
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = yield* sql<{ readonly n: number }>`
          SELECT COUNT(*) AS "n" FROM personal_memory_embeddings
        `;
        if ((rows[0]?.n ?? 0) >= 5) break;
        yield* sleep(10);
      }

      const store = yield* makeMemoryEmbeddingStore(sql, { maxCachedVectors: 3 });
      yield* store.ensureLoaded();
      expect(store.cacheSize()).toBe(3);

      const hits = yield* store.searchSemantic("Vector cache entry", { limit: 10, minCosine: 0.5 });
      expect(hits).toHaveLength(3);
      // The 3 newest entries (3, 4, 5) remain cached; oldest (1, 2) were evicted.
      expect(new Set(hits.map((h) => h.memoryId))).toEqual(new Set(savedIds.slice(2)));

      // Trigger another write past the cap and confirm the WARN is logged only once.
      const sixth = yield* memory.save({
        scope: "shared",
        scopeId: null,
        kind: "note",
        content: "Vector cache entry number 6",
        source: "user",
      });
      yield* store.scheduleEmbed(sixth.memoryId, sixth.content);
      yield* store.flush();
      expect(store.cacheSize()).toBe(3);

      const capWarnings = warnings.filter((msg) => msg.includes("embedding cache reached cap"));
      expect(capWarnings).toHaveLength(1);
    }).pipe(Effect.provide(testLayer));
  });
});
