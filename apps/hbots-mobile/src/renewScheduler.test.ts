import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RENEW_INTERVAL_MS, startRenewScheduler, type ForegroundSource } from "./renewScheduler";

const HOUR = 60 * 60 * 1000;

function fakeForeground() {
  const listeners = new Set<() => void>();
  const source: ForegroundSource = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { source, emit: () => listeners.forEach((listener) => listener()), listeners };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("renew scheduler", () => {
  it("renews once on launch", async () => {
    const run = vi.fn(async () => undefined);
    const stop = startRenewScheduler({
      run,
      onError: vi.fn(),
      foreground: fakeForeground().source,
    });
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("renews every time the app comes to the foreground", async () => {
    const run = vi.fn(async () => undefined);
    const foreground = fakeForeground();
    const stop = startRenewScheduler({ run, onError: vi.fn(), foreground: foreground.source });
    await vi.advanceTimersByTimeAsync(0);
    foreground.emit();
    await vi.advanceTimersByTimeAsync(0);
    foreground.emit();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it("renews every 6 hours while open, and not before", async () => {
    expect(RENEW_INTERVAL_MS).toBe(6 * HOUR);
    const run = vi.fn(async () => undefined);
    const stop = startRenewScheduler({
      run,
      onError: vi.fn(),
      foreground: fakeForeground().source,
    });
    await vi.advanceTimersByTimeAsync(6 * HOUR - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it("skips a tick while the previous renew is still running", async () => {
    let finish: () => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const foreground = fakeForeground();
    const stop = startRenewScheduler({ run, onError: vi.fn(), foreground: foreground.source });
    foreground.emit();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    foreground.emit();
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reports a failed renew and keeps the timer running", async () => {
    const boom = new Error("boom");
    const run = vi.fn(async () => {
      throw boom;
    });
    const onError = vi.fn();
    const stop = startRenewScheduler({ run, onError, foreground: fakeForeground().source });
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops listening and ticking once stopped", async () => {
    const run = vi.fn(async () => undefined);
    const foreground = fakeForeground();
    const stop = startRenewScheduler({ run, onError: vi.fn(), foreground: foreground.source });
    stop();
    foreground.emit();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(run).toHaveBeenCalledTimes(1);
    expect(foreground.listeners.size).toBe(0);
  });
});
