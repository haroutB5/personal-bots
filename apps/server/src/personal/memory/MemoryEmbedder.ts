// @effect-diagnostics nodeBuiltinImport:off - resolves local embedding model cache directory.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import {
  createMemoryEmbeddingWorkerClient,
  type MemoryEmbeddingWorkerClient,
  type MemoryEmbeddingWorkerOptions,
} from "./memoryEmbeddingWorkerClient.ts";
import { normalizeVector, semanticMemoryEnabled } from "./memorySemantic.ts";

export const DEFAULT_EMBEDDING_MODEL_ID = "Xenova/bge-small-en-v1.5";
export const DEFAULT_EMBEDDING_DIMS = 384;
/** After a failed embed, semantic memory stays off this long, then retries. */
export const EMBEDDER_DEGRADED_COOLDOWN_MS = 10 * 60_000;

export interface MemoryEmbedderShape {
  readonly modelId: string;
  readonly dims: number;
  /**
   * Embeds a batch of strings into L2-normalized Float32Arrays.
   * Returns `null` when semantic memory is disabled, unavailable, or fails.
   */
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Float32Array> | null>;
  /** Whether the embedder is currently available for semantic indexing/search. */
  readonly available: Effect.Effect<boolean>;
}

export class MemoryEmbedder extends Context.Service<MemoryEmbedder, MemoryEmbedderShape>()(
  "t3/personal/memory/MemoryEmbedder",
) {}

export const layerDisabled = Layer.succeed(MemoryEmbedder, {
  modelId: DEFAULT_EMBEDDING_MODEL_ID,
  dims: DEFAULT_EMBEDDING_DIMS,
  embed: () => Effect.succeed(null),
  available: Effect.succeed(false),
});

export interface WorkerEmbedderConfig {
  readonly modelId?: string | undefined;
  readonly dims?: number | undefined;
  readonly cacheDir?: string | undefined;
  /** Overrides {@link EMBEDDER_DEGRADED_COOLDOWN_MS} (tests). */
  readonly degradedCooldownMs?: number | undefined;
  /** Test hook: replaces the worker-thread client. */
  readonly createClient?:
    | ((options: MemoryEmbeddingWorkerOptions) => MemoryEmbeddingWorkerClient)
    | undefined;
}

/**
 * Live worker-backed embedder using `@huggingface/transformers` on CPU in a
 * dedicated Worker Thread. Degrades gracefully to unavailable (single WARN log)
 * if the worker fails to load or errors, never crashing or blocking the server.
 * The degraded state is a cooldown, not permanent: after
 * {@link EMBEDDER_DEGRADED_COOLDOWN_MS} the next call tries the worker again.
 */
export const layerWorker = (options?: WorkerEmbedderConfig) =>
  Layer.effect(
    MemoryEmbedder,
    Effect.gen(function* () {
      const config = yield* Effect.serviceOption(ServerConfig);
      const modelId = options?.modelId ?? DEFAULT_EMBEDDING_MODEL_ID;
      const dims = options?.dims ?? DEFAULT_EMBEDDING_DIMS;
      const cacheDir =
        options?.cacheDir ??
        Option.match(config, {
          onSome: (cfg) => NodePath.join(cfg.baseDir, "models", "embeddings"),
          onNone: () => NodePath.join(NodeOS.tmpdir(), "t3code-models", "embeddings"),
        });

      const degradedCooldownMs = options?.degradedCooldownMs ?? EMBEDDER_DEGRADED_COOLDOWN_MS;
      const createClient = options?.createClient ?? createMemoryEmbeddingWorkerClient;
      const client = createClient({ modelId, dims, cacheDir });
      // Epoch ms until which the embedder is considered degraded (0 = healthy).
      let degradedUntil = 0;
      let warned = false;

      yield* Effect.addFinalizer(() => Effect.promise(() => client.dispose()));

      const isDegraded = Effect.map(Clock.currentTimeMillis, (now) => now < degradedUntil);

      const available = Effect.map(isDegraded, (degraded) => !degraded && semanticMemoryEnabled());

      const embed: MemoryEmbedderShape["embed"] = (texts) =>
        Effect.gen(function* () {
          if ((yield* isDegraded) || !semanticMemoryEnabled()) return null;
          if (texts.length === 0) return [];
          return yield* Effect.tryPromise({
            try: () => client.embed(texts),
            catch: (cause) => cause,
          }).pipe(
            Effect.map((vectors) => vectors.map((vec) => normalizeVector(vec))),
            Effect.catch((error) =>
              Effect.gen(function* () {
                degradedUntil = (yield* Clock.currentTimeMillis) + degradedCooldownMs;
                if (!warned) {
                  warned = true;
                  yield* Effect.logWarning(
                    "personal memory semantic embedder unavailable; falling back to FTS5 keyword search",
                    {
                      modelId,
                      retryAfterMs: degradedCooldownMs,
                      error: error instanceof Error ? error.message : String(error),
                    },
                  );
                }
                return null;
              }),
            ),
          );
        });

      return {
        modelId,
        dims,
        embed,
        available,
      } satisfies MemoryEmbedderShape;
    }),
  );
