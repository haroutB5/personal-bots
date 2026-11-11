import { describe, expect, it, vi } from "vite-plus/test";

import {
  createLockController,
  LOCK_OFF,
  isCovered,
  leftApp,
  lockFromChoice,
  lockLabel,
  lockStateAtLaunch,
  parseLock,
  returned,
  serializeLock,
  timeoutMs,
  UNLOCKED,
  type Lock,
} from "./appLock";

const T0 = 1_000_000;

function awayFor(lock: Lock, ms: number) {
  return returned(leftApp(UNLOCKED, T0), lock, T0 + ms).locked;
}

describe("lock setting", () => {
  it("is off by default and when the stored value is damaged", () => {
    expect(parseLock(null)).toEqual(LOCK_OFF);
    expect(parseLock("nonsense")).toEqual(LOCK_OFF);
  });

  it("round-trips each choice", () => {
    for (const lock of [
      LOCK_OFF,
      { kind: "on", timeout: "immediate" },
      { kind: "on", timeout: "1m" },
      { kind: "on", timeout: "5m" },
    ] satisfies Lock[]) {
      expect(parseLock(serializeLock(lock))).toEqual(lock);
      expect(lockFromChoice(serializeLock(lock))).toEqual(lock);
    }
  });

  it("labels each choice", () => {
    expect(lockLabel(LOCK_OFF)).toBe("Off");
    expect(lockLabel({ kind: "on", timeout: "1m" })).toBe("After 1 minute");
  });

  it("uses 0, 1 and 5 minutes", () => {
    expect([timeoutMs("immediate"), timeoutMs("1m"), timeoutMs("5m")]).toEqual([
      0, 60_000, 300_000,
    ]);
  });
});

describe("lock off", () => {
  it("never locks, however long the app was away", () => {
    expect(awayFor(LOCK_OFF, 24 * 60 * 60_000)).toBe(false);
    expect(isCovered(lockStateAtLaunch(LOCK_OFF), LOCK_OFF)).toBe(false);
  });
});

describe("lock on resume", () => {
  const immediate: Lock = { kind: "on", timeout: "immediate" };
  const oneMinute: Lock = { kind: "on", timeout: "1m" };
  const fiveMinutes: Lock = { kind: "on", timeout: "5m" };

  it("immediate locks on any return", () => {
    expect(awayFor(immediate, 0)).toBe(true);
    expect(awayFor(immediate, 500)).toBe(true);
  });

  it("1 minute locks after a minute, not before", () => {
    expect(awayFor(oneMinute, 59_999)).toBe(false);
    expect(awayFor(oneMinute, 60_000)).toBe(true);
    expect(awayFor(oneMinute, 70_000)).toBe(true);
  });

  it("5 minutes locks after five minutes, not before", () => {
    expect(awayFor(fiveMinutes, 4 * 60_000 + 59_000)).toBe(false);
    expect(awayFor(fiveMinutes, 5 * 60_000)).toBe(true);
  });

  it("counts from the first time the app left, not the last event", () => {
    const first = leftApp(UNLOCKED, T0);
    const again = leftApp(first, T0 + 50_000);
    expect(returned(again, oneMinute, T0 + 61_000).locked).toBe(true);
  });

  it("a return without a departure changes nothing", () => {
    expect(returned(UNLOCKED, immediate, T0)).toEqual(UNLOCKED);
  });

  it("stays locked until unlocked, even after a quick return", () => {
    const locked = returned(leftApp(UNLOCKED, T0), oneMinute, T0 + 70_000);
    const quick = returned(leftApp(locked, T0 + 80_000), oneMinute, T0 + 81_000);
    expect(quick.locked).toBe(true);
  });

  it("starts locked at launch, and covers the app while the setting is not loaded", () => {
    expect(lockStateAtLaunch(oneMinute)).toEqual({ locked: true, leftAt: null });
    expect(isCovered(lockStateAtLaunch(oneMinute), oneMinute)).toBe(true);
    expect(isCovered(null, oneMinute)).toBe(true);
    expect(isCovered(UNLOCKED, oneMinute)).toBe(false);
  });
});

function rig(authenticate: () => Promise<boolean> = async () => true) {
  let now = T0;
  const blank = vi.fn<(blank: boolean) => void>();
  const prompts = vi.fn(authenticate);
  const controller = createLockController({
    authenticate: prompts,
    blankRecents: blank,
    now: () => now,
  });
  return {
    controller,
    blank,
    prompts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function settled() {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe("lock controller", () => {
  it("covers the app until the setting is read", () => {
    const { controller } = rig();
    expect(controller.view()).toEqual({ covered: true, locked: false });
    controller.start(LOCK_OFF);
    expect(controller.view()).toEqual({ covered: false, locked: false });
  });

  it("never prompts with the lock off, however long the app was away", () => {
    const { controller, prompts, advance } = rig();
    controller.start(LOCK_OFF);
    controller.presence("background");
    advance(60 * 60_000);
    controller.presence("foreground");

    expect(controller.view().covered).toBe(false);
    expect(prompts).not.toHaveBeenCalled();
  });

  it("starts locked and prompts at launch when the lock is on", async () => {
    const { controller, prompts } = rig();
    controller.start({ kind: "on", timeout: "1m" });
    expect(controller.view()).toEqual({ covered: true, locked: true });
    expect(prompts).toHaveBeenCalledTimes(1);

    await settled();
    expect(controller.view()).toEqual({ covered: false, locked: false });
  });

  it("locks on resume after 1 minute, not before", async () => {
    const { controller, prompts, advance } = rig();
    controller.start({ kind: "on", timeout: "1m" });
    await settled();
    prompts.mockClear();

    controller.presence("background");
    advance(59_000);
    controller.presence("foreground");
    expect(controller.view().locked).toBe(false);
    expect(prompts).not.toHaveBeenCalled();

    controller.presence("background");
    advance(70_000);
    controller.presence("foreground");
    expect(controller.view().locked).toBe(true);
    expect(prompts).toHaveBeenCalledTimes(1);
  });

  it("locks on every resume with Immediately", async () => {
    const { controller, advance } = rig();
    controller.start({ kind: "on", timeout: "immediate" });
    await settled();

    controller.presence("background");
    advance(1);
    controller.presence("foreground");
    expect(controller.view().locked).toBe(true);
  });

  it("locks on resume after 5 minutes, not before", async () => {
    const { controller, advance } = rig();
    controller.start({ kind: "on", timeout: "5m" });
    await settled();

    controller.presence("background");
    advance(4 * 60_000);
    controller.presence("foreground");
    expect(controller.view().locked).toBe(false);

    controller.presence("background");
    advance(5 * 60_000);
    controller.presence("foreground");
    expect(controller.view().locked).toBe(true);
  });

  it("stays locked when the prompt is cancelled, and Unlock asks again", async () => {
    let answer = false;
    const { controller, prompts } = rig(async () => answer);
    controller.start({ kind: "on", timeout: "1m" });
    await settled();
    expect(controller.view().locked).toBe(true);

    answer = true;
    controller.unlock();
    await settled();
    expect(prompts).toHaveBeenCalledTimes(2);
    expect(controller.view().locked).toBe(false);
  });

  it("ignores the app pausing behind the system prompt", async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const { controller, advance } = rig(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    controller.start({ kind: "on", timeout: "immediate" });
    controller.presence("background");
    advance(10);
    controller.presence("foreground");
    finish(true);
    await settled();

    expect(controller.view()).toEqual({ covered: false, locked: false });
    controller.presence("foreground");
    expect(controller.view().locked).toBe(false);
  });

  it("blanks the Recents thumbnail while the lock is on, and not otherwise", () => {
    const { controller, blank } = rig();
    controller.start(LOCK_OFF);
    expect(blank).toHaveBeenLastCalledWith(false);

    controller.setLock({ kind: "on", timeout: "1m" });
    expect(blank).toHaveBeenLastCalledWith(true);

    controller.setLock(LOCK_OFF);
    expect(blank).toHaveBeenLastCalledWith(false);

    controller.setLock({ kind: "on", timeout: "5m" });
    controller.dispose();
    expect(blank).toHaveBeenLastCalledWith(false);
  });

  it("turning the lock on mid-session does not lock the user out", () => {
    const { controller, prompts } = rig();
    controller.start(LOCK_OFF);
    controller.setLock({ kind: "on", timeout: "1m" });

    expect(controller.view()).toEqual({ covered: false, locked: false });
    expect(prompts).not.toHaveBeenCalled();
  });

  it("tells subscribers only when the view changes", async () => {
    const { controller } = rig();
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.start(LOCK_OFF);
    controller.presence("background");
    controller.presence("foreground");

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
