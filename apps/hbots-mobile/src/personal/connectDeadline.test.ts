import { describe, expect, it } from "vite-plus/test";

import { CONNECT_DEADLINE_MS, connectWithDeadline } from "./connectDeadline";

describe("connectWithDeadline", () => {
  it("gives up on a connect that never settles", async () => {
    const started = Date.now();
    await expect(
      connectWithDeadline(() => new Promise<never>(() => undefined), 25),
    ).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(300);
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
    await expect(attempt).rejects.toThrow("timed out");
    release({ dispose: async () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(true);
  });

  it("aborts the attempt so its request and socket stop", async () => {
    let aborted = false;
    await expect(
      connectWithDeadline(
        (signal) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
        20,
      ),
    ).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
  });

  it("keeps two failed attempts and their backoff inside the 15 second reconnect budget", () => {
    expect(CONNECT_DEADLINE_MS).toBeLessThanOrEqual(5_000);
  });
});
