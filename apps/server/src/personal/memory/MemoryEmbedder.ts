// @effect-diagnostics nodeBuiltinImport:off - resolves local embedding model cache directory.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../../config.ts";
import { createMemoryEmbeddingWorkerClient } from "./memoryEmbeddingWorkerClient.ts";
import { normalizeVector, semanticMemoryEnabled } from "./memorySemantic.ts";

export const DEFAULT_EMBEDDING_MODEL_ID = "Xenova/bge-small-en-v1.5";
export const DEFAULT_EMBEDDING_DIMS = 384;

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
}

/**
 * Live worker-backed embedder using `@huggingface/transformers` on CPU in a
 * dedicated Worker Thread. Degrades gracefully to unavailable (single WARN log)
 * if the worker fails to load or errors, never crashing or blocking the server.
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

      const client = createMemoryEmbeddingWorkerClient({ modelId, dims, cacheDir });
      let degraded = false;
      let warned = false;

      yield* Effect.addFinalizer(() => Effect.promise(() => client.dispose()));

      const available = Effect.sync(() => !degraded && semanticMemoryEnabled());

      const embed: MemoryEmbedderShape["embed"] = (texts) =>
        Effect.gen(function* () {
          if (degraded || !semanticMemoryEnabled()) return null;
          if (texts.length === 0) return [];
          return yield* Effect.tryPromise({
            try: () => client.embed(texts),
            catch: (cause) => cause,
          }).pipe(
            Effect.map((vectors) => vectors.map((vec) => normalizeVector(vec))),
            Effect.catch((error) =>
              Effect.gen(function* () {
                degraded = true;
                if (!warned) {
                  warned = true;
                  yield* Effect.logWarning(
                    "personal memory semantic embedder unavailable; falling back to FTS5 keyword search",
                    {
                      modelId,
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
