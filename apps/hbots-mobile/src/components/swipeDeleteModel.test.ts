import { describe, expect, it } from "vite-plus/test";

import { ARMED, CLOSED, nextSwipeDelete } from "./swipeDeleteModel.ts";

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
