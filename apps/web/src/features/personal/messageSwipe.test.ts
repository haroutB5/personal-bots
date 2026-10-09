import { describe, expect, it } from "vite-plus/test";

import { EDGE_WIDTH_PX } from "./edgeSwipeBack";
import {
  startsInEdgeZone,
  SWIPE_AXIS_RATIO,
  SWIPE_FIRST_SHOWN_PX,
  SWIPE_FULL_REVEAL_PX,
  SWIPE_LOCK_PX,
  SWIPE_MAX_REVEAL_PX,
  swipeAxis,
  swipeGoesTheWay,
  swipeOffset,
  swipeTimeOpacity,
} from "./messageSwipe";
import { LONG_PRESS_SLOP_PX } from "./useLongPress";

describe("swipeAxis", () => {
  it("waits until the finger has moved enough to tell", () => {
    expect(swipeAxis(0, 0)).toBeNull();
    expect(swipeAxis(SWIPE_LOCK_PX - 1, 0)).toBeNull();
    expect(swipeAxis(-(SWIPE_LOCK_PX - 1), SWIPE_LOCK_PX - 1)).toBeNull();
    expect(swipeAxis(0, SWIPE_LOCK_PX - 1)).toBeNull();
  });

  it("locks at the long press's slop, so a press is already over when a swipe starts", () => {
    expect(SWIPE_LOCK_PX).toBe(LONG_PRESS_SLOP_PX);
  });

  it("calls a clearly sideways move a swipe, in either direction", () => {
    expect(swipeAxis(SWIPE_LOCK_PX, 0)).toBe("x");
    expect(swipeAxis(-SWIPE_LOCK_PX, 0)).toBe("x");
    expect(swipeAxis(-30, 5)).toBe("x");
  });

  it("calls an up or down move a scroll", () => {
    expect(swipeAxis(0, SWIPE_LOCK_PX)).toBe("y");
    expect(swipeAxis(2, -40)).toBe("y");
  });

  it("lets scrolling win when the move is mostly, not only, vertical", () => {
    // A diagonal and a tie are scrolls; only a move well past the ratio is a swipe.
    expect(swipeAxis(20, 20)).toBe("y");
    expect(swipeAxis(24, 20)).toBe("y");
    expect(swipeAxis(30, 20)).toBe("y");
    expect(swipeAxis(31, 20)).toBe("x");
    expect(SWIPE_AXIS_RATIO).toBeGreaterThan(1);
  });
});

describe("swipeGoesTheWay", () => {
  it("is left for the owner's messages and right for a bot's", () => {
    expect(swipeGoesTheWay(-20, "end")).toBe(true);
    expect(swipeGoesTheWay(20, "end")).toBe(false);
    expect(swipeGoesTheWay(20, "start")).toBe(true);
    expect(swipeGoesTheWay(-20, "start")).toBe(false);
    expect(swipeGoesTheWay(0, "end")).toBe(false);
    expect(swipeGoesTheWay(0, "start")).toBe(false);
  });
});

describe("swipeOffset", () => {
  it("starts at nothing at the lock, so the message does not jump", () => {
    expect(swipeOffset(-SWIPE_LOCK_PX, "end")).toBe(0);
    expect(swipeOffset(SWIPE_LOCK_PX, "start")).toBe(0);
    expect(swipeOffset(-3, "end")).toBe(0);
  });

  it("follows towards the empty side: negative for the owner, positive for a bot", () => {
    expect(swipeOffset(-40, "end")).toBeLessThan(0);
    expect(swipeOffset(40, "start")).toBeGreaterThan(0);
    expect(swipeOffset(-40, "end")).toBe(-swipeOffset(40, "start"));
  });

  it("does not move the wrong way", () => {
    expect(swipeOffset(60, "end")).toBe(0);
    expect(swipeOffset(-60, "start")).toBe(0);
  });

  it("follows the finger about one to one at first, then resists, and never passes the cap", () => {
    const small = Math.abs(swipeOffset(-(SWIPE_LOCK_PX + 10), "end"));
    expect(small).toBeGreaterThan(8);
    expect(small).toBeLessThanOrEqual(10);
    let previous = 0;
    for (let dx = SWIPE_LOCK_PX; dx <= 600; dx += 4) {
      const offset = Math.abs(swipeOffset(-dx, "end"));
      expect(offset).toBeGreaterThanOrEqual(previous);
      // Resistance: it never moves faster than the finger.
      expect(offset).toBeLessThanOrEqual(Math.max(0, dx - SWIPE_LOCK_PX) + 1e-9);
      expect(offset).toBeLessThanOrEqual(SWIPE_MAX_REVEAL_PX);
      previous = offset;
    }
    expect(previous).toBeGreaterThan(SWIPE_MAX_REVEAL_PX - 1);
    // About the middle of the 60 to 70 px range the time needs by a 100 px drag.
    expect(Math.abs(swipeOffset(-100, "end"))).toBeGreaterThan(55);
  });
});

describe("swipeTimeOpacity", () => {
  it("is hidden for a nudge, rises with the travel and is full before the cap", () => {
    expect(swipeTimeOpacity(0)).toBe(0);
    expect(swipeTimeOpacity(SWIPE_FIRST_SHOWN_PX)).toBe(0);
    expect(swipeTimeOpacity(SWIPE_FULL_REVEAL_PX)).toBe(1);
    expect(swipeTimeOpacity(SWIPE_MAX_REVEAL_PX)).toBe(1);
    const middle = swipeTimeOpacity((SWIPE_FIRST_SHOWN_PX + SWIPE_FULL_REVEAL_PX) / 2);
    expect(middle).toBeGreaterThan(0.4);
    expect(middle).toBeLessThan(0.6);
    expect(SWIPE_FULL_REVEAL_PX).toBeLessThan(SWIPE_MAX_REVEAL_PX);
  });

  it("reads the distance, whichever way the message moved", () => {
    expect(swipeTimeOpacity(-30)).toBe(swipeTimeOpacity(30));
  });
});

describe("startsInEdgeZone", () => {
  it("leaves a touch in the edge swipe back's strip to that swipe", () => {
    expect(startsInEdgeZone(0)).toBe(true);
    expect(startsInEdgeZone(EDGE_WIDTH_PX - 1)).toBe(true);
    expect(startsInEdgeZone(EDGE_WIDTH_PX)).toBe(false);
    expect(startsInEdgeZone(200)).toBe(false);
  });
});
