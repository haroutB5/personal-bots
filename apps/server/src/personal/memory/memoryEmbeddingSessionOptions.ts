// Pipeline options for the local ONNX embedding worker
// (`src/memory-embedding-worker.ts`). Kept in a side-effect-free module so the
// thread caps are unit-testable without loading the worker entry.

/**
 * ONNX Runtime intra-op threads for the embedding session. onnxruntime-node
 * defaults to one thread per core, so the first-boot backfill of the whole
 * memory corpus could saturate the CPU beside the live server.
 */
export const EMBEDDING_INTRA_OP_THREADS = 2;
/** Inter-op threads (parallel graph branches); the bge-small graph is sequential. */
export const EMBEDDING_INTER_OP_THREADS = 1;

export interface EmbeddingPipelineOptions {
  readonly dtype: "q8";
  readonly device: "cpu";
  readonly session_options: {
    readonly intraOpNumThreads: number;
    readonly interOpNumThreads: number;
  };
}

/** Options passed to `pipeline("feature-extraction", modelId, ...)` (@huggingface/transformers 4.x). */
export const embeddingPipelineOptions = (): EmbeddingPipelineOptions => ({
  dtype: "q8",
  device: "cpu",
  session_options: {
    intraOpNumThreads: EMBEDDING_INTRA_OP_THREADS,
    interOpNumThreads: EMBEDDING_INTER_OP_THREADS,
  },
});
