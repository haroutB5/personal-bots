import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DeadlineError,
  RETRY_MAX_DELAY_MS,
  SNAPSHOT_DEADLINE_MS,
  orFallbackAfter,
  retryDelayMs,
  startWithRetry,
  withDeadline,
} from "./startup";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startup deadline", () => {
  it("falls back when a native call never answers", async () => {
    const hung = new Promise<string>(() => {});
    const result = orFallbackAfter<string | null>(hung, SNAPSHOT_DEADLINE_MS, null);

    await vi.advanceTimersByTimeAsync(SNAPSHOT_DEADLINE_MS);

    await expect(result).resolves.toBeNull();
  });

  it("falls back when a native call throws", async () => {
    await expect(
      orFallbackAfter<string | null>(Promise.reject(new Error("boom")), 2_000, null),
    ).resolves.toBeNull();
  });

  it("keeps a late answer out once the deadline passed", async () => {
    let answer: (value: string) => void = () => {};
    const slow = new Promise<string>((resolve) => {
      answer = resolve;
    });
    const result = orFallbackAfter<string | null>(slow, 2_000, null);
    await vi.advanceTimersByTimeAsync(2_000);
    answer("late");

    await expect(result).resolves.toBeNull();
  });

  it("returns the answer when it arrives in time", async () => {
    await expect(orFallbackAfter<string | null>(Promise.resolve("ok"), 2_000, null)).resolves.toBe(
      "ok",
    );
  });

  it("rejects, rather than inventing a value, when a deadline carries no fallback", async () => {
    const result = withDeadline(new Promise<string>(() => {}), 5_000, "The saved session");
    const settled = result.then(
      () => "resolved",
      (cause: unknown) => cause,
    );

    await vi.advanceTimersByTimeAsync(5_000);

    const cause = await settled;
    expect(cause).toBeInstanceOf(DeadlineError);
    expect((cause as Error).message).toBe("The saved session did not answer in time.");
  });
});

describe("startup retry", () => {
  it("waits 1 s, 2 s, 4 s and so on, never more than 30 s", () => {
    expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retryDelayMs(10)).toBe(RETRY_MAX_DELAY_MS);
  });

  it("runs once and stops when the step is done", async () => {
    const step = vi.fn(async () => "done" as const);
    startWithRetry(step);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(step).toHaveBeenCalledTimes(1);
  });

  it("tries again after a step that fails", async () => {
    const step = vi
      .fn<(attempt: number) => Promise<"done" | "retry">>()
      .mockRejectedValueOnce(new Error("keystore"))
      .mockResolvedValue("done");
    startWithRetry(step);
    await vi.advanceTimersByTimeAsync(999);
    expect(step).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(step.mock.calls.map(([attempt]) => attempt)).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("tries again after a step that asks for a retry, with a growing wait", async () => {
    const step = vi.fn(async () => "retry" as const);
    startWithRetry(step);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(step).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(step).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(step).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once stopped", async () => {
    const step = vi.fn(async () => "retry" as const);
    const stop = startWithRetry(step);
    await vi.advanceTimersByTimeAsync(0);

    stop();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(step).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a retry for a step still running when stopped", async () => {
    let finish: (value: "retry") => void = () => {};
    const step = vi.fn(
      () =>
        new Promise<"retry">((resolve) => {
          finish = resolve;
        }),
    );
    const stop = startWithRetry(step);
    stop();
    finish("retry");

    await vi.advanceTimersByTimeAsync(120_000);

    expect(step).toHaveBeenCalledTimes(1);
  });
});
