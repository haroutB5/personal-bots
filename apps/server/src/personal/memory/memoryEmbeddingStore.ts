// In-memory vector cache, non-blocking async indexing queue, and idle
// background backfill for personal memory embeddings.
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../../serverActivation.ts";
import { redactSecrets } from "../secretText.ts";
import { MemoryEmbedder } from "./MemoryEmbedder.ts";
import {
  contentHash,
  decodeVector,
  dotProductNormalized,
  encodeVector,
  normalizeVector,
  semanticMemoryEnabled,
} from "./memorySemantic.ts";

export interface SemanticHit {
  readonly memoryId: string;
  readonly cosine: number;
}

interface CachedEmbedding {
  readonly vector: Float32Array;
  readonly contentHash: string;
}

const BACKFILL_BATCH_SIZE = 16;

/** Maximum vectors kept in the in-memory LRU cache (~34 MB at 384 dims). */
export const MAX_CACHED_VECTORS = 20_000;

/**
 * Budget for the query-time embed on the per-turn retrieval path. The worker
 * can take up to its 60 s cold timeout (first use after boot, after each idle
 * termination, or offline model download); a turn must never wait for that.
 * On timeout the search falls back to FTS5 only and the embed keeps running so
 * it warms the model for the next turn. Backfill and indexing are unbounded here.
 */
export const QUERY_EMBED_TIMEOUT_MS = 2_500;

export interface MemoryEmbeddingStoreOptions {
  /** Overrides {@link QUERY_EMBED_TIMEOUT_MS} (tests). */
  readonly queryEmbedTimeoutMs?: number | undefined;
  /** Overrides {@link MAX_CACHED_VECTORS} (tests). */
  readonly maxCachedVectors?: number | undefined;
}

export const makeMemoryEmbeddingStore = (
  sql: SqlClient.SqlClient,
  options?: MemoryEmbeddingStoreOptions,
) =>
  Effect.gen(function* () {
    const queryEmbedTimeoutMs = options?.queryEmbedTimeoutMs ?? QUERY_EMBED_TIMEOUT_MS;
    const maxCachedVectors = Math.max(1, options?.maxCachedVectors ?? MAX_CACHED_VECTORS);
    const embedderOption = yield* Effect.serviceOption(MemoryEmbedder);

    const cache = new Map<string, CachedEmbedding>();
    const generations = new Map<string, number>();
    let loaded = false;
    let loadingPromise: Promise<void> | undefined;
    let inFlightCount = 0;
    let cacheCapWarned = false;
    const idleWaiters: Array<() => void> = [];

    const warnCacheCapOnce = (): Effect.Effect<void> => {
      if (cacheCapWarned) return Effect.void;
      cacheCapWarned = true;
      return Effect.logWarning(
        "personal memory embedding cache reached cap; evicting oldest entries",
        { maxCachedVectors, size: cache.size },
      );
    };

    const putCache = (memoryId: string, entry: CachedEmbedding): boolean => {
      cache.delete(memoryId);
      cache.set(memoryId, entry);
      let evicted = false;
      while (cache.size > maxCachedVectors) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
        evicted = true;
      }
      return evicted;
    };

    const bumpGeneration = (memoryId: string): number => {
      const next = (generations.get(memoryId) ?? 0) + 1;
      generations.set(memoryId, next);
      return next;
    };

    const notifyIdleIfDone = () => {
      if (inFlightCount > 0) return;
      const waiters = idleWaiters.splice(0, idleWaiters.length);
      for (const resolve of waiters) resolve();
    };

    const upsertRow = (
      memoryId: string,
      modelId: string,
      dims: number,
      vector: Float32Array,
      hash: string,
    ) =>
      Effect.gen(function* () {
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const blob = encodeVector(vector);
        yield* sql`
          INSERT INTO personal_memory_embeddings (
            memory_id, model, dims, vector, content_hash, updated_at
          )
          VALUES (${memoryId}, ${modelId}, ${dims}, ${blob}, ${hash}, ${nowIso})
          ON CONFLICT (memory_id) DO UPDATE SET
            model = excluded.model,
            dims = excluded.dims,
            vector = excluded.vector,
            content_hash = excluded.content_hash,
            updated_at = excluded.updated_at
        `;
      });

    /** Lazily hydrates the in-memory vector map from SQLite for live entries. */
    const ensureLoaded = (): Effect.Effect<void> =>
      Option.match(embedderOption, {
        onNone: () => Effect.void,
        onSome: (embedder) =>
          Effect.gen(function* () {
            if (loaded) return;
            if (loadingPromise !== undefined) {
              yield* Effect.promise(() => loadingPromise!);
              return;
            }
            const loadEffect = sql<{
              readonly memoryId: string;
              readonly vector: Uint8Array;
              readonly contentHash: string;
            }>`
              SELECT e.memory_id AS "memoryId", e.vector AS "vector", e.content_hash AS "contentHash"
              FROM personal_memory_embeddings e
              JOIN personal_memory m ON m.memory_id = e.memory_id
              WHERE m.deleted_at IS NULL
                AND m.superseded_at IS NULL
                AND e.model = ${embedder.modelId}
                AND e.dims = ${embedder.dims}
              ORDER BY m.updated_at DESC, m.seq DESC
              LIMIT ${maxCachedVectors + 1}
            `.pipe(
              Effect.flatMap((rows) =>
                Effect.gen(function* () {
                  let hitCap = rows.length > maxCachedVectors;
                  const kept = hitCap ? rows.slice(0, maxCachedVectors) : rows;
                  // Insert oldest-to-newest so newest entries sit at the MRU end of the Map.
                  for (let idx = kept.length - 1; idx >= 0; idx -= 1) {
                    const row = kept[idx]!;
                    // Do not overwrite entries already mutated in memory during load.
                    if (generations.has(row.memoryId)) continue;
                    const decoded = decodeVector(row.vector, embedder.dims);
                    if (decoded !== null) {
                      if (
                        putCache(row.memoryId, {
                          vector: normalizeVector(decoded),
                          contentHash: row.contentHash,
                        })
                      ) {
                        hitCap = true;
                      }
                    }
                  }
                  loaded = true;
                  if (hitCap) {
                    yield* warnCacheCapOnce();
                  }
                }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("personal memory embedding cache load failed", {
                      cause: redactSecrets(Cause.pretty(cause)).slice(0, 1_000),
                    }),
              ),
            );
            let resolveLoad: () => void = () => undefined;
            loadingPromise = new Promise<void>((resolve) => {
              resolveLoad = resolve;
            });
            try {
              yield* loadEffect;
            } finally {
              loadingPromise = undefined;
              resolveLoad();
            }
          }),
      });

    /** Synchronously evicts an entry from the in-memory cache and invalidates in-flight embeds. */
    const evict = (memoryId: string): void => {
      bumpGeneration(memoryId);
      cache.delete(memoryId);
    };

    /** Evicts from cache and deletes the persisted embedding row (for tombstoned/removed entries). */
    const removeEmbedding = (memoryId: string): Effect.Effect<void> => {
      evict(memoryId);
      return sql`DELETE FROM personal_memory_embeddings WHERE memory_id = ${memoryId}`.pipe(
        Effect.asVoid,
        Effect.orElseSucceed(() => undefined),
      );
    };

    /**
     * Non-blocking async embed after a save/update/restore commits.
     * Never blocks the caller's SQLite transaction.
     */
    const scheduleEmbed = (memoryId: string, content: string): Effect.Effect<void> =>
      Option.match(embedderOption, {
        onNone: () => Effect.void,
        onSome: (embedder) => {
          const trimmed = content.trim();
          if (trimmed.length === 0 || !semanticMemoryEnabled()) return Effect.void;
          const hash = contentHash(trimmed);
          const cached = cache.get(memoryId);
          if (cached !== undefined && cached.contentHash === hash) return Effect.void;
          const gen = bumpGeneration(memoryId);
          inFlightCount += 1;

          const work = Effect.gen(function* () {
            if (!(yield* embedder.available)) return;
            // If DB already has an up-to-date vector for this model/hash (e.g. after restore), reuse it.
            const existing = yield* sql<{ readonly vector: Uint8Array }>`
              SELECT vector FROM personal_memory_embeddings
              WHERE memory_id = ${memoryId}
                AND model = ${embedder.modelId}
                AND dims = ${embedder.dims}
                AND content_hash = ${hash}
              LIMIT 1
            `.pipe(Effect.orElseSucceed(() => []));
            if (existing[0] !== undefined) {
              const decoded = decodeVector(existing[0].vector, embedder.dims);
              if (decoded !== null && generations.get(memoryId) === gen) {
                if (putCache(memoryId, { vector: normalizeVector(decoded), contentHash: hash })) {
                  yield* warnCacheCapOnce();
                }
                return;
              }
            }
            const vectors = yield* embedder.embed([trimmed]);
            const rawVec = vectors?.[0];
            if (rawVec === undefined || rawVec.length !== embedder.dims) return;
            if (generations.get(memoryId) !== gen) return;
            const normalized = normalizeVector(rawVec);
            yield* upsertRow(memoryId, embedder.modelId, embedder.dims, normalized, hash);
            if (generations.get(memoryId) === gen) {
              if (putCache(memoryId, { vector: normalized, contentHash: hash })) {
                yield* warnCacheCapOnce();
              }
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("personal memory async embedding failed", {
                    memoryId,
                    cause: redactSecrets(Cause.pretty(cause)).slice(0, 1_000),
                  }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                inFlightCount = Math.max(0, inFlightCount - 1);
                notifyIdleIfDone();
              }),
            ),
          );

          return Effect.forkDetach(work).pipe(Effect.asVoid);
        },
      });

    /** Waits for any in-flight scheduled embeddings to settle (primarily for tests). */
    const flush = (): Effect.Effect<void> =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (inFlightCount === 0) {
              resolve();
              return;
            }
            idleWaiters.push(resolve);
          }),
      );

    /** Runs a fast exact cosine scan over the in-memory vector cache. */
    const searchSemantic = (
      queryText: string,
      options: {
        readonly limit: number;
        readonly minCosine: number;
        readonly allowedIds?: ReadonlySet<string> | undefined;
      },
    ): Effect.Effect<ReadonlyArray<SemanticHit>> =>
      Option.match(embedderOption, {
        onNone: () => Effect.succeed([]),
        onSome: (embedder) =>
          Effect.gen(function* () {
            if (!semanticMemoryEnabled()) return [];
            if (!(yield* embedder.available)) return [];
            const trimmed = queryText.trim();
            if (trimmed.length === 0) return [];
            yield* ensureLoaded();
            if (cache.size === 0) return [];
            if (options.allowedIds !== undefined && options.allowedIds.size === 0) return [];
            // Run the embed in its own detached fiber and wait at most the budget:
            // a timeout only stops waiting (FTS5-only for this turn); the embed
            // itself is never interrupted, so it finishes and warms the worker,
            // and the embedder is not marked degraded.
            const embedFiber = yield* Effect.forkDetach(embedder.embed([trimmed]));
            const joined = yield* Fiber.join(embedFiber).pipe(
              Effect.timeoutOption(queryEmbedTimeoutMs),
            );
            if (Option.isNone(joined)) {
              yield* Effect.logDebug("personal memory query embed over budget; using FTS5 only", {
                budgetMs: queryEmbedTimeoutMs,
              });
              return [];
            }
            const vectors = joined.value;
            const rawQuery = vectors?.[0];
            if (rawQuery === undefined || rawQuery.length !== embedder.dims) return [];
            const queryVec = normalizeVector(rawQuery);
            const hits: Array<SemanticHit> = [];
            for (const [memoryId, item] of cache) {
              if (options.allowedIds !== undefined && !options.allowedIds.has(memoryId)) continue;
              const cosine = dotProductNormalized(queryVec, item.vector);
              if (cosine >= options.minCosine) {
                hits.push({ memoryId, cosine });
              }
            }
            hits.sort((a, b) => b.cosine - a.cosine);
            return hits.slice(0, options.limit);
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("personal memory semantic search failed; using FTS5 only", {
                    cause: redactSecrets(Cause.pretty(cause)).slice(0, 1_000),
                  }).pipe(Effect.as([] as ReadonlyArray<SemanticHit>)),
            ),
          ),
      });

    /** Backfills missing or stale embeddings for live rows in small batches with yield pauses. */
    const runBackfill = (): Effect.Effect<number> =>
      Option.match(embedderOption, {
        onNone: () => Effect.succeed(0),
        onSome: (embedder) =>
          Effect.gen(function* () {
            if (!semanticMemoryEnabled()) return 0;
            if (!(yield* embedder.available)) return 0;
            yield* ensureLoaded();
            let totalIndexed = 0;
            let afterSeq = 0;

            while (true) {
              if (!semanticMemoryEnabled() || !(yield* embedder.available)) break;
              const rows = yield* sql<{
                readonly seq: number;
                readonly memoryId: string;
                readonly content: string;
                readonly storedModel: string | null;
                readonly storedHash: string | null;
              }>`
                SELECT
                  m.seq AS "seq",
                  m.memory_id AS "memoryId",
                  m.content AS "content",
                  e.model AS "storedModel",
                  e.content_hash AS "storedHash"
                FROM personal_memory m
                LEFT JOIN personal_memory_embeddings e ON e.memory_id = m.memory_id
                WHERE m.deleted_at IS NULL
                  AND m.superseded_at IS NULL
                  AND m.content <> ''
                  AND m.seq > ${afterSeq}
                ORDER BY m.seq ASC
                LIMIT ${BACKFILL_BATCH_SIZE}
              `;
              if (rows.length === 0) break;
              afterSeq = rows[rows.length - 1]!.seq;

              const stale = rows
                .map((row) => ({
                  memoryId: row.memoryId,
                  content: row.content.trim(),
                  hash: contentHash(row.content.trim()),
                  storedModel: row.storedModel,
                  storedHash: row.storedHash,
                }))
                .filter(
                  (row) =>
                    row.content.length > 0 &&
                    (row.storedModel !== embedder.modelId || row.storedHash !== row.hash),
                );

              if (stale.length > 0) {
                const gens = stale.map((item) => bumpGeneration(item.memoryId));
                const vectors = yield* embedder.embed(stale.map((item) => item.content));
                if (vectors === null) break;
                for (let i = 0; i < stale.length; i += 1) {
                  const item = stale[i]!;
                  const rawVec = vectors[i];
                  if (rawVec === undefined || rawVec.length !== embedder.dims) continue;
                  if (generations.get(item.memoryId) !== gens[i]) continue;
                  const normalized = normalizeVector(rawVec);
                  yield* upsertRow(
                    item.memoryId,
                    embedder.modelId,
                    embedder.dims,
                    normalized,
                    item.hash,
                  );
                  if (generations.get(item.memoryId) === gens[i]) {
                    if (putCache(item.memoryId, { vector: normalized, contentHash: item.hash })) {
                      yield* warnCacheCapOnce();
                    }
                    totalIndexed += 1;
                  }
                }
              }

              // Yield between batches so backfill never starves SQLite or interactive turns.
              yield* Effect.sleep("50 millis");
            }
            return totalIndexed;
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("personal memory embedding backfill stopped", {
                    cause: redactSecrets(Cause.pretty(cause)).slice(0, 1_000),
                  }).pipe(Effect.as(0)),
            ),
          ),
      });

    const startBackfill = (): Effect.Effect<void, never, Scope.Scope> =>
      Option.match(embedderOption, {
        onNone: () => Effect.void,
        onSome: () => forkParked(runBackfill().pipe(Effect.asVoid)),
      });

    return {
      isConfigured: Option.isSome(embedderOption),
      cacheSize: () => cache.size,
      ensureLoaded,
      evict,
      removeEmbedding,
      scheduleEmbed,
      flush,
      searchSemantic,
      runBackfill,
      startBackfill,
    };
  });

export type MemoryEmbeddingStore = Effect.Success<ReturnType<typeof makeMemoryEmbeddingStore>>;
