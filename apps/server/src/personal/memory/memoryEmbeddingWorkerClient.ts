// @effect-diagnostics nodeBuiltinImport:off - dedicated worker thread keeps CPU ONNX inference off the main event loop.
import * as NodeSea from "node:sea";
import * as NodeTimers from "node:timers";
import * as NodeWorkerThreads from "node:worker_threads";

export interface MemoryEmbeddingWorkerOptions {
  readonly modelId: string;
  readonly dims: number;
  readonly cacheDir: string;
  /** Timeout for the first embed call (model load/cache warm). Default: 60s. */
  readonly initialTimeoutMs?: number | undefined;
  /** Timeout for subsequent embed calls. Default: 15s. */
  readonly requestTimeoutMs?: number | undefined;
  /** Idle duration before terminating the worker to free RAM. Default: 5m. */
  readonly idleMs?: number | undefined;
}

interface WorkerResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly vectors?: ReadonlyArray<Float32Array>;
  readonly error?: string;
}

export interface MemoryEmbeddingWorkerClient {
  readonly embed: (texts: ReadonlyArray<string>) => Promise<ReadonlyArray<Float32Array>>;
  readonly dispose: () => Promise<void>;
}

const DEFAULT_INITIAL_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_IDLE_MS = 5 * 60_000;

/**
 * Lazy, serialized Worker Thread client for local ONNX embeddings.
 * Resolves `../../memory-embedding-worker.ts` in dev and `./memory-embedding-worker.mjs`
 * in bundled dist builds.
 */
export function createMemoryEmbeddingWorkerClient(
  options: MemoryEmbeddingWorkerOptions,
): MemoryEmbeddingWorkerClient {
  const initialTimeoutMs = options.initialTimeoutMs ?? DEFAULT_INITIAL_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

  let worker: NodeWorkerThreads.Worker | undefined;
  let idleTimer: ReturnType<typeof NodeTimers.setTimeout> | undefined;
  let warmed = false;
  let nextId = 1;
  let queue: Promise<unknown> = Promise.resolve();

  const clearIdleTimer = () => {
    if (idleTimer !== undefined) {
      NodeTimers.clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const terminateWorker = async (target?: NodeWorkerThreads.Worker) => {
    const active = target ?? worker;
    if (active === undefined) return;
    if (worker === active) {
      worker = undefined;
      warmed = false;
    }
    clearIdleTimer();
    try {
      await active.terminate();
    } catch {
      // Ignore termination errors on already-exited workers.
    }
  };

  const embed = (texts: ReadonlyArray<string>): Promise<ReadonlyArray<Float32Array>> => {
    if (texts.length === 0) return Promise.resolve([]);
    const run = queue.then(() => {
      if (NodeSea.isSea()) {
        throw new Error("Memory embedding worker requires a script runtime");
      }
      clearIdleTimer();
      const active = (worker ??= new NodeWorkerThreads.Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../memory-embedding-worker.ts"
            : "./memory-embedding-worker.mjs",
          import.meta.url,
        ),
        {
          workerData: {
            modelId: options.modelId,
            dims: options.dims,
            cacheDir: options.cacheDir,
          },
        },
      ));
      if (active.listenerCount("error") === 0) {
        active.on("error", () => {
          if (worker === active) {
            worker = undefined;
            warmed = false;
          }
        });
      }
      active.ref();
      const requestId = nextId++;
      const timeoutMs = warmed ? requestTimeoutMs : initialTimeoutMs;

      return new Promise<ReadonlyArray<Float32Array>>((resolve, reject) => {
        let settled = false;
        let timeoutHandle: ReturnType<typeof NodeTimers.setTimeout> | undefined;

        const cleanup = () => {
          if (timeoutHandle !== undefined) {
            NodeTimers.clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
          active.removeListener("message", onMessage);
          active.removeListener("error", onError);
          active.removeListener("exit", onExit);
        };

        const failRequest = (error: Error, killWorker: boolean) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (killWorker) {
            void terminateWorker(active);
          } else {
            active.unref();
          }
          reject(error);
        };

        const onError = (error: Error) => failRequest(error, true);
        const onExit = (code: number) =>
          failRequest(new Error(`Memory embedding worker exited (${code})`), true);

        const onMessage = (message: WorkerResponse) => {
          if (message.id !== requestId) return;
          if (settled) return;
          settled = true;
          cleanup();
          active.unref();
          // @effect-diagnostics-next-line globalTimers:off - worker idle cleanup timer must unref outside any fiber
          idleTimer = NodeTimers.setTimeout(() => {
            void terminateWorker(active);
          }, idleMs);
          idleTimer.unref();
          if (!message.ok || message.vectors === undefined) {
            reject(new Error(message.error ?? "Memory embedding worker returned an error"));
            return;
          }
          warmed = true;
          resolve(message.vectors);
        };

        // @effect-diagnostics-next-line globalTimers:off - per-request worker timeout outside any fiber
        timeoutHandle = NodeTimers.setTimeout(() => {
          failRequest(new Error(`Memory embedding worker timed out after ${timeoutMs}ms`), true);
        }, timeoutMs);
        timeoutHandle.unref();

        active.on("message", onMessage);
        active.once("error", onError);
        active.once("exit", onExit);

        try {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker port takes no target origin
          active.postMessage({ id: requestId, texts: [...texts] });
        } catch (error) {
          failRequest(error instanceof Error ? error : new Error(String(error)), true);
        }
      });
    });

    queue = run.catch(() => undefined);
    return run;
  };

  return {
    embed,
    dispose: () => terminateWorker(),
  };
}
