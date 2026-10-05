import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";

import { ADAPTIVE_JPEG_TIMING, createMotionController } from "./adaptiveJpeg.ts";
import type { ScreencastProfile } from "./driver.ts";
import { optionsFromEnvironment } from "./PersonalBrowser.ts";

/** A controller on a clock and timers the test moves by hand; `apply` is held open until released. */
const fixture = () => {
  const clock = { now: 1_000 };
  const timers = new Map<number, { readonly at: number; readonly run: () => void }>();
  let nextTimer = 1;
  const applied: ScreencastProfile[] = [];
  const changes: ScreencastProfile[] = [];
  let holds: Array<() => void> = [];
  let hold = false;
  let fail = false;
  const controller = createMotionController({
    now: () => clock.now,
    setTimer: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock.now + ms, run });
      return id;
    },
    clearTimer: (timer) => timers.delete(timer as number),
    apply: (profile) => {
      applied.push(profile);
      if (fail) return Promise.reject(new Error("browser said no"));
      if (!hold) return Promise.resolve();
      return new Promise<void>((resolve) => holds.push(resolve));
    },
    onChange: (profile) => changes.push(profile),
  });
  /** Moves the clock and fires every timer that came due on the way, in order. */
  const advance = (ms: number) => {
    const until = clock.now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      timers.delete(due[0]);
      clock.now = Math.max(clock.now, due[1].at);
      due[1].run();
    }
    clock.now = until;
  };
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    controller,
    applied,
    changes,
    timers,
    advance,
    settle,
    holdApplies: () => {
      hold = true;
    },
    failApplies: () => {
      fail = true;
    },
    releaseApplies: () => {
      const waiting = holds;
      holds = [];
      for (const resolve of waiting) resolve();
    },
  };
};

describe("adaptive JPEG motion controller", () => {
  it("starts sharp and treats a single wheel step as a nudge, not motion", async () => {
    const f = fixture();
    expect(f.controller.profile()).toBe("sharp");
    f.controller.wheel();
    await f.settle();
    expect(f.controller.profile()).toBe("sharp");
    expect(f.applied).toEqual([]);
    expect(f.timers.size).toBe(0);
  });

  it("two wheels close together are motion; the picture goes rough once", async () => {
    const f = fixture();
    f.controller.wheel();
    f.advance(ADAPTIVE_JPEG_TIMING.enterWithinMs - 20);
    f.controller.wheel();
    await f.settle();
    expect(f.controller.profile()).toBe("moving");
    for (let i = 0; i < 20; i += 1) {
      f.advance(30);
      f.controller.wheel();
    }
    await f.settle();
    expect(f.applied).toEqual(["moving"]);
    expect(f.changes).toEqual(["moving"]);
  });

  it("two single notches further apart than the entry window stay sharp", async () => {
    const f = fixture();
    f.controller.wheel();
    f.advance(ADAPTIVE_JPEG_TIMING.enterWithinMs + 40);
    f.controller.wheel();
    f.advance(ADAPTIVE_JPEG_TIMING.enterWithinMs + 40);
    f.controller.wheel();
    await f.settle();
    expect(f.applied).toEqual([]);
  });

  it("goes back to sharp once the wheel has been quiet for the settle time, and not before", async () => {
    const f = fixture();
    f.controller.wheel();
    f.advance(40);
    f.controller.wheel();
    await f.settle();
    f.advance(ADAPTIVE_JPEG_TIMING.settleMs - 10);
    await f.settle();
    expect(f.controller.profile()).toBe("moving");
    f.advance(20);
    await f.settle();
    expect(f.controller.profile()).toBe("sharp");
    expect(f.applied).toEqual(["moving", "sharp"]);
    expect(f.changes).toEqual(["moving", "sharp"]);
  });

  it("a wheel inside the settle time pushes the settle back instead of arming a timer per wheel", async () => {
    const f = fixture();
    f.controller.wheel();
    f.advance(40);
    f.controller.wheel();
    for (let i = 0; i < 40; i += 1) {
      f.advance(25);
      f.controller.wheel();
      expect(f.timers.size).toBeLessThanOrEqual(1);
    }
    await f.settle();
    // 1 s of steady wheels never settled.
    expect(f.controller.profile()).toBe("moving");
    f.advance(ADAPTIVE_JPEG_TIMING.settleMs + 5);
    await f.settle();
    expect(f.controller.profile()).toBe("sharp");
  });

  it("applies profiles one at a time and in order while the browser is slow", async () => {
    const f = fixture();
    f.holdApplies();
    f.controller.wheel();
    f.advance(40);
    f.controller.wheel();
    await f.settle();
    expect(f.applied).toEqual(["moving"]);
    // The page settles while the switch to rough is still running: sharp waits its turn.
    f.advance(ADAPTIVE_JPEG_TIMING.settleMs + 10);
    await f.settle();
    expect(f.applied).toEqual(["moving"]);
    f.releaseApplies();
    await f.settle();
    expect(f.applied).toEqual(["moving", "sharp"]);
    f.releaseApplies();
    await f.settle();
    expect(f.applied).toEqual(["moving", "sharp"]);
  });

  it("skips a switch that was asked for and withdrawn before the browser got to it", async () => {
    const f = fixture();
    f.holdApplies();
    // A first run of motion is being applied...
    f.controller.wheel();
    f.advance(40);
    f.controller.wheel();
    await f.settle();
    // ...it ends and a second one begins before the first apply returns.
    f.advance(ADAPTIVE_JPEG_TIMING.settleMs + 10);
    f.controller.wheel();
    f.advance(40);
    f.controller.wheel();
    await f.settle();
    f.releaseApplies();
    await f.settle();
    // The browser is already rough, so the sharp-then-rough pair in between is never sent.
    expect(f.applied).toEqual(["moving"]);
    expect(f.controller.profile()).toBe("moving");
  });

  it("reset puts both sides back to sharp, cancels the timer and ignores an apply that finishes later", async () => {
    const f = fixture();
    f.holdApplies();
    f.controller.wheel();
    f.advance(40);
    f.controller.wheel();
    await f.settle();
    expect(f.timers.size).toBe(1);
    f.controller.reset();
    expect(f.timers.size).toBe(0);
    expect(f.controller.profile()).toBe("sharp");
    expect(f.changes).toEqual(["moving", "sharp"]);
    // The old screencast's switch finishes now: it must not mark the new screencast as rough.
    f.releaseApplies();
    await f.settle();
    // A fresh run of motion on the new screencast asks for rough again.
    f.controller.wheel();
    f.advance(40);
    f.controller.wheel();
    await f.settle();
    expect(f.applied).toEqual(["moving", "moving"]);
  });

  it("a reset while sharp changes nothing and says nothing", () => {
    const f = fixture();
    f.controller.reset();
    expect(f.changes).toEqual([]);
    expect(f.applied).toEqual([]);
  });

  it("a switch the browser refuses does not wedge the controller", async () => {
    const f = fixture();
    f.failApplies();
    f.controller.wheel();
    f.advance(40);
    f.controller.wheel();
    await f.settle();
    f.advance(ADAPTIVE_JPEG_TIMING.settleMs + 10);
    await f.settle();
    expect(f.controller.profile()).toBe("sharp");
    expect(f.applied).toEqual(["moving", "sharp"]);
  });
});

describe("adaptive JPEG kill switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is on by default", () => {
    vi.stubEnv("T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG", "");
    expect(optionsFromEnvironment().adaptiveJpeg).toBe(true);
  });

  it("is off with T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=off, spaces and all", () => {
    vi.stubEnv("T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG", " off ");
    expect(optionsFromEnvironment().adaptiveJpeg).toBe(false);
  });

  it("stays on for any other value", () => {
    vi.stubEnv("T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG", "on");
    expect(optionsFromEnvironment().adaptiveJpeg).toBe(true);
  });
});
