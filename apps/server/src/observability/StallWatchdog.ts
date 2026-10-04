// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - worker_threads has no Effect equivalent, and the heartbeat must run on the bare event loop it measures, outside the Effect runtime.
import * as NodeWorkerThreads from "node:worker_threads";

import { STALL_WATCHDOG_WORKER_SOURCE, type ProfileSummary } from "./stallWatchdogWorker.ts";

export type StallProfilerMode = "continuous" | "detect" | "off";

/** What the worker saw of one stretch where the main thread did not run. */
export interface WatchdogStall {
  /** Epoch ms of the last heartbeat before the stall. */
  readonly startedAt: number;
  readonly endedAt: number;
  /** How long the main thread was blocked, beyond the normal heartbeat gap. */
  readonly durationMs: number;
  readonly profilerMode: StallProfilerMode;
  /** Detect mode only: how long the profiler took to start. A stall-long answer means the
   * main thread was inside native code that cannot be interrupted. */
  readonly profileStartLatencyMs: number | null;
  /** How long the main thread took to hand over the profile once it was free again. */
  readonly profileStopLatencyMs: number;
  readonly profilerError: string | null;
  /** Process CPU time since the last healthy check, against the wall time of that span. */
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly cpuWallMs: number;
  readonly freeMemMb: number;
  readonly rssMb: number;
  readonly summary: ProfileSummary | null;
}

export interface StallWatchdogOptions {
  readonly thresholdMs?: number;
  /** Profiler sampling interval in µs, 5,000 to 200,000. */
  readonly sampleIntervalUs?: number | undefined;
  readonly profilerMode?: StallProfilerMode;
  readonly onStall: (stall: WatchdogStall) => void;
  readonly onError?: (message: string) => void;
}

export interface StallWatchdog {
  readonly profilerMode: StallProfilerMode;
  readonly stop: () => Promise<void>;
}

const HEARTBEAT_MS = 200;
const POLL_MS = 250;
const DEFAULT_THRESHOLD_MS = 1000;
// 50 ms sampling: a 1 s stall holds about 20 samples. Measured on this laptop: about +0.3% of
// one core at 50 ms, +1% at 20 ms.
const DEFAULT_SAMPLE_INTERVAL_US = 50_000;
// Continuous mode drops its accumulated profile this often so it cannot grow without bound.
const ROTATE_MS = 10 * 60_000;

export const stallProfilerModeFromEnv = (
  value: string | undefined,
  fallback: StallProfilerMode = "continuous",
): StallProfilerMode => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "0" || normalized === "false") return "off";
  if (normalized === "detect") return "detect";
  if (normalized === "continuous") return "continuous";
  return fallback;
};

/**
 * Starts the watchdog worker and the main thread's heartbeat. Both are unref'd, so
 * neither keeps the process alive. `stop` ends the worker.
 */
export const startStallWatchdog = (options: StallWatchdogOptions): StallWatchdog => {
  const profilerMode = options.profilerMode ?? "continuous";
  const sab = new SharedArrayBuffer(4);
  const beat = new Int32Array(sab);
  const writeBeat = () => Atomics.store(beat, 0, Date.now() | 0);
  writeBeat();
  const heartbeat = setInterval(writeBeat, HEARTBEAT_MS);
  heartbeat.unref();

  const worker = new NodeWorkerThreads.Worker(STALL_WATCHDOG_WORKER_SOURCE, {
    eval: true,
    workerData: {
      sab,
      thresholdMs: options.thresholdMs ?? DEFAULT_THRESHOLD_MS,
      pollMs: POLL_MS,
      heartbeatMs: HEARTBEAT_MS,
      profilerMode,
      sampleIntervalUs: Math.min(
        200_000,
        Math.max(5_000, Math.round(options.sampleIntervalUs ?? DEFAULT_SAMPLE_INTERVAL_US)),
      ),
      rotateMs: ROTATE_MS,
      topN: 8,
      maxDepth: 12,
    },
    // A small worker: it only holds a heartbeat and one profile summary at a time.
    resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 24 },
  });
  worker.unref();
  worker.on("message", (message: { type: string } & Record<string, unknown>) => {
    if (message.type === "stall") options.onStall(message as unknown as WatchdogStall);
    else if (message.type === "error") options.onError?.(String(message.message));
  });
  worker.on("error", (error) => options.onError?.(String(error)));

  let stopped = false;
  return {
    profilerMode,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
      try {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker thread, not window.postMessage.
        worker.postMessage({ type: "stop" });
      } catch {
        // The worker already exited.
      }
      // Let the worker close its inspector session itself; kill it if it does not. The
      // timer is not unref'd: a process with nothing else left would otherwise exit
      // before the worker's exit event arrives.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1500);
        }),
      ]);
      clearTimeout(timer);
      await worker.terminate();
    },
  };
};
