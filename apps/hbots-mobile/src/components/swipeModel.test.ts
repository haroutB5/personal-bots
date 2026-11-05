import { describe, expect, it } from "vite-plus/test";

import { claimsSwipe, dragOffset, restOffset, settleRest, swipeReach } from "./swipeModel";

const reach = swipeReach(2, 2);

describe("swipeReach", () => {
  it("is 88 pixels per action", () => {
    expect(reach).toEqual({ leading: 176, trailing: 176 });
    expect(swipeReach(0, 1)).toEqual({ leading: 0, trailing: 88 });
  });
});

describe("restOffset", () => {
  it("slides left for trailing actions and right for leading ones", () => {
    expect(restOffset("closed", reach)).toBe(0);
    expect(restOffset("left", reach)).toBe(-176);
    expect(restOffset("right", reach)).toBe(176);
  });
});

describe("dragOffset", () => {
  it("follows the finger from where the row rests", () => {
    expect(dragOffset("closed", -60, reach)).toBe(-60);
    expect(dragOffset("left", 100, reach)).toBe(-76);
  });

  it("stops at the edge of the actions", () => {
    expect(dragOffset("closed", -500, reach)).toBe(-176);
    expect(dragOffset("closed", 500, reach)).toBe(176);
  });

  it("does not slide towards a side without actions", () => {
    expect(dragOffset("closed", 80, swipeReach(0, 2))).toBe(0);
    expect(dragOffset("closed", -80, swipeReach(2, 0))).toBe(0);
  });
});

describe("settleRest", () => {
  it("opens past 45 percent and shuts short of it", () => {
    expect(settleRest(-80, reach)).toBe("left");
    expect(settleRest(-79, reach)).toBe("closed");
    expect(settleRest(80, reach)).toBe("right");
    expect(settleRest(79, reach)).toBe("closed");
  });

  it("stays shut on a side without actions", () => {
    expect(settleRest(-200, swipeReach(2, 0))).toBe("closed");
    expect(settleRest(200, swipeReach(0, 2))).toBe("closed");
  });
});

describe("claimsSwipe", () => {
  it("takes a mostly horizontal drag past the slop only", () => {
    expect(claimsSwipe(20, 5)).toBe(true);
    expect(claimsSwipe(8, 0)).toBe(false);
    expect(claimsSwipe(20, 30)).toBe(false);
  });
});
