// @effect-diagnostics nodeBuiltinImport:off - the page script runs in a node:vm context here.
import * as NodeVM from "node:vm";

import { describe, expect, it } from "@effect/vitest";

import {
  SCROLL_SETTLE_CAP_MS,
  SCROLL_SETTLE_NO_ANSWER,
  scrollSettleExpression,
  settleOutcome,
} from "./scrollSettle.ts";

/** Runs the page script against a fake page whose scroll offset is set frame by frame. */
const settleAgainst = (offsets: ReadonlyArray<number>, frameMs = 16) => {
  const frames: Array<() => void> = [];
  const state = { now: 1_000 };
  const page = {
    scrollX: 0,
    scrollY: 0,
    performance: { now: () => state.now },
    document: {
      elementFromPoint: () => ({ scrollTop: 0, scrollLeft: 0, parentElement: null }),
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    setTimeout: () => 0,
  };
  const context = NodeVM.createContext(page);
  const result = NodeVM.runInContext(scrollSettleExpression(190, 380), context) as Promise<number>;
  const answer: { value?: number } = {};
  void result.then((value) => {
    answer.value = value;
  });
  const frameCount = Math.max(offsets.length, 40);
  return (async () => {
    for (let frame = 0; frame < frameCount && answer.value === undefined; frame += 1) {
      page.scrollY = offsets[Math.min(frame, offsets.length - 1)] ?? 0;
      state.now += frameMs;
      const run = frames.splice(0);
      for (const callback of run) callback();
      await Promise.resolve();
    }
    return answer.value;
  })();
};

describe("scroll settle script", () => {
  it("returns once the offsets have stayed put for three frames", async () => {
    // Still scrolling for three frames, then still.
    const waited = await settleAgainst([4420, 4440, 4460, 4480, 4480, 4480, 4480, 4480]);
    expect(waited).toBeGreaterThanOrEqual(6 * 16);
    expect(waited).toBeLessThan(SCROLL_SETTLE_CAP_MS);
  });

  it("returns after a few frames when nothing was scrolling", async () => {
    const waited = await settleAgainst([100, 100, 100, 100, 100]);
    expect(waited).toBeLessThanOrEqual(4 * 16);
  });

  it("gives up at the cap on a page that never stops moving", async () => {
    const moving = Array.from({ length: 60 }, (_, index) => index * 10);
    const waited = await settleAgainst(moving);
    expect(waited).toBeGreaterThanOrEqual(SCROLL_SETTLE_CAP_MS);
    expect(waited).toBeLessThan(SCROLL_SETTLE_CAP_MS + 40);
  });

  it("reads numbers only: nothing but a duration leaves the page", async () => {
    expect(typeof (await settleAgainst([1, 1, 1, 1, 1]))).toBe("number");
    expect(scrollSettleExpression(Number.NaN, Number.POSITIVE_INFINITY)).toContain("(0, 0, ");
  });

  it("reports a wait and whether the cap was hit", () => {
    expect(settleOutcome(48, 51)).toEqual({ waitedMs: 48, capped: false });
    expect(settleOutcome(SCROLL_SETTLE_CAP_MS + 30, 250)).toEqual({
      waitedMs: SCROLL_SETTLE_CAP_MS + 30,
      capped: true,
    });
    // The page did not answer (a hidden tab): the time we waited, capped.
    expect(settleOutcome(SCROLL_SETTLE_NO_ANSWER, 240)).toEqual({ waitedMs: 240, capped: true });
    expect(settleOutcome(undefined, 12)).toEqual({ waitedMs: 12, capped: false });
  });
});
