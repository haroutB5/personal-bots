/**
 * Kill switches for performance changes (web-perf-loop skill).
 *
 * Every optimization that changes when or how work happens is on by default
 * and can be turned off on one device without a release:
 *
 *   localStorage.setItem("perf-off", "preload-next,early-paint")
 *
 * The bench's --off / --ab set the same key, so one build can be measured
 * with a change on and off, interleaved.
 */
export const PERF_OFF_STORAGE_KEY = "perf-off";

export type PerfOptimization = "preload-next" | "early-paint" | "rum";

export function perfOptimizationOn(name: PerfOptimization): boolean {
  try {
    const off = globalThis.localStorage?.getItem(PERF_OFF_STORAGE_KEY);
    return (
      !off ||
      !off
        .split(",")
        .map((s) => s.trim())
        .includes(name)
    );
  } catch {
    return true;
  }
}

/** Runs `work` when the main thread is idle (a timer where requestIdleCallback is missing, e.g. iOS Safari). */
export function whenIdle(work: () => void, fallbackMs = 1500): () => void {
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  if (typeof g.requestIdleCallback === "function") {
    const handle = g.requestIdleCallback(work, { timeout: fallbackMs * 2 });
    return () => g.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(work, fallbackMs);
  return () => clearTimeout(handle);
}
