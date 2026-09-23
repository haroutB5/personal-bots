import { describe, expect, it } from "@effect/vitest";

import { DesktopLockCore } from "./DesktopLock.ts";

const ada = { threadId: "t-ada", botId: "b-ada", botName: "Ada" };
const bob = { threadId: "t-bob", botId: "b-bob", botName: "Bob" };
const cy = { threadId: "t-cy", botId: "b-cy", botName: "Cy" };

describe("DesktopLockCore", () => {
  it("gives a free PC to the first bot and queues the rest in arrival order", () => {
    const lock = new DesktopLockCore(1_000);
    expect(lock.claim(ada, 0).status).toBe("granted");
    expect(lock.claim(bob, 1)).toMatchObject({ status: "queued", position: 1 });
    expect(lock.claim(cy, 2)).toMatchObject({ status: "queued", position: 2 });
    // A repeat claim keeps its place instead of joining twice.
    expect(lock.claim(bob, 3)).toMatchObject({ status: "queued", position: 1 });
    expect(lock.waiting.map((entry) => entry.botName)).toEqual(["Bob", "Cy"]);
  });

  it("hands the PC to the next in line on release", () => {
    const lock = new DesktopLockCore(1_000);
    lock.claim(ada, 0);
    lock.claim(bob, 1);
    const handOver = lock.release(ada.threadId, 5);
    expect(handOver.previous?.botName).toBe("Ada");
    expect(handOver.promoted).toMatchObject({ botName: "Bob", since: 5, lastActionAt: 5 });
    expect(lock.holder?.botName).toBe("Bob");
    expect(lock.waiting).toEqual([]);
  });

  it("ignores a release from a bot that does not hold the PC", () => {
    const lock = new DesktopLockCore(1_000);
    lock.claim(ada, 0);
    lock.claim(bob, 1);
    expect(lock.release(bob.threadId, 2)).toEqual({ previous: null, promoted: null });
    expect(lock.holder?.botName).toBe("Ada");
  });

  it("takes the PC off an idle holder and promotes the next bot", () => {
    const lock = new DesktopLockCore(1_000);
    lock.claim(ada, 0);
    lock.claim(bob, 10);
    lock.touch(ada.threadId, 500);
    expect(lock.expireIdle(1_400).previous).toBeNull();
    const handOver = lock.expireIdle(1_500);
    expect(handOver.previous?.botName).toBe("Ada");
    expect(handOver.promoted?.botName).toBe("Bob");
  });

  it("stopAll frees the PC and turns every waiting bot away", () => {
    const lock = new DesktopLockCore(1_000);
    lock.claim(ada, 0);
    lock.claim(bob, 1);
    lock.claim(cy, 2);
    const result = lock.stopAll();
    expect(result.stopped?.botName).toBe("Ada");
    expect(result.turnedAway.map((entry) => entry.botName)).toEqual(["Bob", "Cy"]);
    expect(lock.holder).toBeNull();
    expect(lock.waiting).toEqual([]);
    // Nothing was promoted: the next claim starts fresh.
    expect(lock.claim(cy, 3).status).toBe("granted");
  });

  it("drops a bot that gave up waiting", () => {
    const lock = new DesktopLockCore(1_000);
    lock.claim(ada, 0);
    lock.claim(bob, 1);
    lock.claim(cy, 2);
    expect(lock.leaveLine(bob.threadId)).toBe(true);
    expect(lock.release(ada.threadId, 3).promoted?.botName).toBe("Cy");
  });
});
