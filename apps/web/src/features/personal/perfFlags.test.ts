import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PERF_OFF_STORAGE_KEY, perfOptimizationOn, whenIdle } from "./perfFlags";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const storage = (value: string | null) => ({
  getItem: (key: string) => (key === PERF_OFF_STORAGE_KEY ? value : null),
});

describe("perfOptimizationOn", () => {
  it("is on by default and off when listed", () => {
    vi.stubGlobal("localStorage", storage(null));
    expect(perfOptimizationOn("preload-chat")).toBe(true);
    vi.stubGlobal("localStorage", storage(" rum , preload-chat"));
    expect(perfOptimizationOn("preload-chat")).toBe(false);
    expect(perfOptimizationOn("rum")).toBe(false);
    vi.stubGlobal("localStorage", storage("rum"));
    expect(perfOptimizationOn("preload-chat")).toBe(true);
  });

  it("stays on when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(perfOptimizationOn("preload-chat")).toBe(true);
  });
});

describe("whenIdle", () => {
  it("falls back to a timer without requestIdleCallback, and can be cancelled", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const work = vi.fn();
    whenIdle(work, 1_000);
    vi.advanceTimersByTime(999);
    expect(work).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(work).toHaveBeenCalledOnce();

    const cancelled = vi.fn();
    whenIdle(cancelled, 1_000)();
    vi.advanceTimersByTime(2_000);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("uses requestIdleCallback when there is one", () => {
    const idle = vi.fn((callback: () => void) => {
      callback();
      return 7;
    });
    vi.stubGlobal("requestIdleCallback", idle);
    const work = vi.fn();
    whenIdle(work);
    expect(idle).toHaveBeenCalledOnce();
    expect(work).toHaveBeenCalledOnce();
  });
});
