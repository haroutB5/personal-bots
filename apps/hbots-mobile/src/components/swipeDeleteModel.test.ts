import { describe, expect, it } from "vite-plus/test";

import {
  ARMED,
  armedRowsAfterArm,
  armedRowsAfterTouch,
  armTimedOut,
  CLOSED,
  nextSwipeDelete,
  SWIPE_ARM_TIMEOUT_MS,
} from "./swipeDeleteModel.ts";

const swipe = (distance: number) => ({ kind: "swipe" as const, distance, threshold: 40 });

describe("nextSwipeDelete", () => {
  it("arms on the first left swipe and does not delete", () => {
    expect(nextSwipeDelete(CLOSED, swipe(-60))).toEqual({ state: ARMED, effect: "none" });
  });

  it("commits on the second left swipe", () => {
    expect(nextSwipeDelete(ARMED, swipe(-60))).toEqual({ state: CLOSED, effect: "commit" });
  });

  it("closes when a right swipe follows the first", () => {
    expect(nextSwipeDelete(ARMED, swipe(30))).toEqual({ state: CLOSED, effect: "none" });
  });

  it("leaves a short swipe alone", () => {
    expect(nextSwipeDelete(CLOSED, swipe(-20))).toEqual({ state: CLOSED, effect: "none" });
    expect(nextSwipeDelete(ARMED, swipe(-20))).toEqual({ state: ARMED, effect: "none" });
  });

  it("disarms on a tap elsewhere", () => {
    expect(nextSwipeDelete(ARMED, { kind: "dismiss" })).toEqual({
      state: CLOSED,
      effect: "none",
    });
  });
});

describe("armed rows", () => {
  it("closes an armed row when another row is touched", () => {
    expect([...armedRowsAfterTouch(new Set(["a"]), "b")]).toEqual([]);
  });

  it("keeps the armed row when its own row is touched", () => {
    expect([...armedRowsAfterTouch(new Set(["a"]), "a")]).toEqual(["a"]);
  });

  it("closes the old row when another row arms", () => {
    expect([...armedRowsAfterArm(new Set(["a"]), "b")]).toEqual(["b"]);
  });
});

describe("armTimedOut", () => {
  it("keeps a fresh arm open and closes it at five seconds", () => {
    expect(armTimedOut(1_000, 1_000)).toBe(false);
    expect(armTimedOut(1_000, 1_000 + SWIPE_ARM_TIMEOUT_MS - 1)).toBe(false);
    expect(armTimedOut(1_000, 1_000 + SWIPE_ARM_TIMEOUT_MS)).toBe(true);
  });
});
