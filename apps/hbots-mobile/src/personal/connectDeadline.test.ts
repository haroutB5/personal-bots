import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CONNECT_DEADLINE_MS, connectWithDeadline } from "./connectDeadline";

describe("connectWithDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a connect that never settles", async () => {
    const attempt = connectWithDeadline(() => new Promise<never>(() => undefined), 25);
    const outcome = expect(attempt).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(25);
    await outcome;
  });

  it("returns a connect that settles inside the deadline", async () => {
    const session = { dispose: async () => undefined };
    await expect(connectWithDeadline(async () => session, 100)).resolves.toBe(session);
  });

  it("disposes a session that settles after the deadline", async () => {
    let disposed = false;
    let release: (session: { dispose: () => Promise<void> }) => void = () => undefined;
    const pending = new Promise<{ dispose: () => Promise<void> }>((resolve) => {
      release = resolve;
    });
    const attempt = connectWithDeadline(
      () =>
        pending.then((session) => ({
          ...session,
          dispose: async () => {
            disposed = true;
            await session.dispose();
          },
        })),
      20,
    );
    const outcome = expect(attempt).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    release({ dispose: async () => undefined });
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toBe(true);
  });

  it("aborts the attempt so its request and socket stop", async () => {
    let aborted = false;
    const attempt = connectWithDeadline(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      20,
    );
    const outcome = expect(attempt).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    expect(aborted).toBe(true);
  });

  it("keeps two failed attempts and their backoff inside the 15 second reconnect budget", () => {
    expect(CONNECT_DEADLINE_MS).toBeLessThanOrEqual(5_000);
  });
});
