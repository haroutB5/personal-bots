// @effect-diagnostics nodeBuiltinImport:off - isolated ONNX embedding worker entry.
import * as NodeWorkerThreads from "node:worker_threads";

interface WorkerConfig {
  readonly modelId: string;
  readonly dims: number;
  readonly cacheDir: string;
}

interface EmbedRequest {
  readonly id: number;
  readonly texts: ReadonlyArray<string>;
}

interface EmbedResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly vectors?: ReadonlyArray<Float32Array>;
  readonly error?: string;
}

type FeatureExtractor = (
  texts: string | ReadonlyArray<string>,
  options: { readonly pooling: "mean"; readonly normalize: boolean },
) => Promise<{ readonly data: ArrayLike<number>; readonly dims: ReadonlyArray<number> }>;

const config = (NodeWorkerThreads.workerData ?? {}) as Partial<WorkerConfig>;
const modelId = config.modelId ?? "Xenova/bge-small-en-v1.5";
const fallbackDims = config.dims ?? 384;
const cacheDir = config.cacheDir ?? "";

let extractorPromise: Promise<FeatureExtractor> | undefined;

async function getExtractor(): Promise<FeatureExtractor> {
  if (extractorPromise !== undefined) return extractorPromise;
  extractorPromise = (async () => {
    const transformers = await import("@huggingface/transformers");
    if (cacheDir.length > 0) {
      transformers.env.cacheDir = cacheDir;
    }
    transformers.env.allowLocalModels = true;
    transformers.env.useBrowserCache = false;
    const pipe = await transformers.pipeline("feature-extraction", modelId, {
      dtype: "q8",
      device: "cpu",
    });
    return pipe as unknown as FeatureExtractor;
  })().catch((error) => {
    extractorPromise = undefined;
    throw error;
  });
  return extractorPromise;
}

let queue: Promise<void> = Promise.resolve();

NodeWorkerThreads.parentPort?.on("message", (request: EmbedRequest) => {
  queue = queue.then(async () => {
    let response: EmbedResponse;
    try {
      if (request.texts.length === 0) {
        response = { id: request.id, ok: true, vectors: [] };
      } else {
        const extractor = await getExtractor();
        const output = await extractor([...request.texts], {
          pooling: "mean",
          normalize: true,
        });
        const raw = output.data;
        const outDims = output.dims[output.dims.length - 1] ?? fallbackDims;
        const vectors: Array<Float32Array> = [];
        for (let i = 0; i < request.texts.length; i += 1) {
          const offset = i * outDims;
          const vec = new Float32Array(outDims);
          for (let j = 0; j < outDims; j += 1) {
            vec[j] = Number(raw[offset + j] ?? 0);
          }
          vectors.push(vec);
        }
        response = { id: request.id, ok: true, vectors };
      }
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    NodeWorkerThreads.parentPort?.postMessage(response);
  });
});
