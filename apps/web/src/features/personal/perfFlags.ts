/**
 * Kill switches for performance changes. Every optimization that changes
 * when or how work happens is on by default and can be turned off on one
 * device without a release:
 *
 *   localStorage.setItem("bots:perf-off", "preload-chat")   // comma-separated
 *
 * The perf bench uses the same key to measure each change on and off in one
 * build (scripts/personal/perf/README.md).
 */
export const PERF_OFF_STORAGE_KEY = "bots:perf-off";

export type PerfOptimization =
  | "preload-chat"
  | "snapshot-early"
  | "warm-highlighter"
  | "rum"
  | "stale-reload"
  | "lean-shell";

export function perfOptimizationOn(name: PerfOptimization): boolean {
  try {
    const off = globalThis.localStorage?.getItem(PERF_OFF_STORAGE_KEY);
    if (!off) return true;
    return !off
      .split(",")
      .map((entry) => entry.trim())
      .includes(name);
  } catch {
    return true;
  }
}

/**
 * Runs `work` when the main thread is idle, or after `fallbackMs` where the
 * browser has no requestIdleCallback (iOS Safari). Returns a cancel function.
 */
export function whenIdle(work: () => void, fallbackMs = 1_500): () => void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") {
    const handle = idle(work, { timeout: fallbackMs * 2 });
    return () =>
      (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(work, fallbackMs);
  return () => clearTimeout(handle);
}
