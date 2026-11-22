import { describe, expect, it } from "vite-plus/test";

import {
  clampDragDx,
  classifyRelease,
  DRAG_SLOP_DP,
  dropIndex,
  moveTo,
  PINNED_TILE_STEP,
  pinnedRenderOrder,
  pinnedRestX,
  pinnedSettleOffset,
  pinnedShiftFor,
  reorderByDrag,
  sameOrder,
} from "./pinnedOrderModel.ts";

describe("dropIndex", () => {
  it("moves right by whole tiles", () => {
    expect(dropIndex(164, 82, 0, 4)).toBe(2);
  });

  it("moves left and clamps at the ends", () => {
    expect(dropIndex(-90, 82, 3, 4)).toBe(2);
    expect(dropIndex(-800, 82, 1, 4)).toBe(0);
    expect(dropIndex(800, 82, 1, 4)).toBe(3);
  });

  it("stays put for a small drag", () => {
    expect(dropIndex(20, 82, 1, 4)).toBe(1);
  });
});

describe("classifyRelease", () => {
  it("opens the actions sheet when a lift did not move", () => {
    expect(classifyRelease(0, false)).toBe("sheet");
    expect(classifyRelease(6, false)).toBe("sheet");
  });

  it("reorders after a real drag", () => {
    expect(classifyRelease(DRAG_SLOP_DP + 1, true)).toBe("reorder");
    expect(classifyRelease(-DRAG_SLOP_DP - 1, true)).toBe("reorder");
  });

  it("does nothing when a drag comes back to the start", () => {
    expect(classifyRelease(2, true)).toBe("none");
  });
});

describe("reorderByDrag", () => {
  it("looks the tile's index up in the current order, not the mount-time order", () => {
    let order: ReadonlyArray<string> = ["A", "B", "C"];

    order = reorderByDrag(order, "C", -PINNED_TILE_STEP * 2);
    expect(order).toEqual(["C", "A", "B"]);

    order = reorderByDrag(order, "A", PINNED_TILE_STEP);
    expect(order).toEqual(["C", "B", "A"]);
  });

  it("ignores a bot that is no longer in the strip", () => {
    expect(reorderByDrag(["A", "B"], "gone", PINNED_TILE_STEP)).toEqual(["A", "B"]);
  });
});

describe("moveTo", () => {
  it("moves the third pin to the front", () => {
    expect(moveTo(["a", "b", "c", "d"], 2, 0)).toEqual(["c", "a", "b", "d"]);
  });

  it("moves a pin to the end", () => {
    expect(moveTo(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("returns the same order for the same slot", () => {
    expect(moveTo(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("pinnedShiftFor", () => {
  const shifts = (from: number, hover: number, count = 5) =>
    Array.from({ length: count }, (_, index) => pinnedShiftFor(index, from, hover));

  it("moves nothing while hovering the home slot", () => {
    expect(shifts(2, 2)).toEqual([0, 0, 0, 0, 0]);
  });

  it("slides tiles left when dragging right", () => {
    expect(shifts(1, 3)).toEqual([0, 0, -PINNED_TILE_STEP, -PINNED_TILE_STEP, 0]);
  });

  it("slides tiles right when dragging left", () => {
    expect(shifts(3, 1)).toEqual([0, PINNED_TILE_STEP, PINNED_TILE_STEP, 0, 0]);
  });

  it("matches the order moveTo produces", () => {
    const ids = ["a", "b", "c", "d", "e"];
    for (let from = 0; from < ids.length; from++) {
      for (let hover = 0; hover < ids.length; hover++) {
        const after = moveTo(ids, from, hover);
        ids.forEach((id, index) => {
          if (index === from) return;
          const shifted = index + pinnedShiftFor(index, from, hover) / PINNED_TILE_STEP;
          expect(after.indexOf(id)).toBe(shifted);
        });
      }
    }
  });

  it("honours a custom step", () => {
    expect(pinnedShiftFor(2, 0, 2, 50)).toBe(-50);
  });
});

describe("pinnedSettleOffset", () => {
  it("is the signed slot distance times the step", () => {
    expect(pinnedSettleOffset(1, 3)).toBe(2 * PINNED_TILE_STEP);
    expect(pinnedSettleOffset(3, 1)).toBe(-2 * PINNED_TILE_STEP);
    expect(pinnedSettleOffset(2, 2)).toBe(0);
  });

  it("round-trips through dropIndex", () => {
    expect(dropIndex(pinnedSettleOffset(1, 3), PINNED_TILE_STEP, 1, 5)).toBe(3);
  });
});

describe("pinnedRenderOrder", () => {
  it("keeps the mounted order while the same bots are pinned", () => {
    const previous = ["a", "b", "c"];
    expect(pinnedRenderOrder(previous, ["c", "a", "b"])).toBe(previous);
  });

  it("takes the visual order when the set of bots changes", () => {
    expect(pinnedRenderOrder(["a", "b"], ["b", "a", "c"])).toEqual(["b", "a", "c"]);
    expect(pinnedRenderOrder(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a"]);
    expect(pinnedRenderOrder([], ["a"])).toEqual(["a"]);
  });

  it("takes the visual order when asked to normalize", () => {
    expect(pinnedRenderOrder(["a", "b", "c"], ["c", "a", "b"], true)).toEqual(["c", "a", "b"]);
    const same = ["a", "b"];
    expect(pinnedRenderOrder(same, ["a", "b"], true)).toBe(same);
  });

  it("does not treat duplicates as the same set", () => {
    expect(pinnedRenderOrder(["a", "a"], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("sameOrder", () => {
  it("compares element by element", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
  });
});

describe("pinnedRestX", () => {
  it("is zero when mounted in visual order and idle", () => {
    expect(pinnedRestX(2, 2, null)).toBe(0);
  });

  it("offsets a tile mounted elsewhere into its visual slot", () => {
    expect(pinnedRestX(0, 3, null)).toBe(-3 * PINNED_TILE_STEP);
    expect(pinnedRestX(3, 1, null)).toBe(2 * PINNED_TILE_STEP);
  });

  it("adds the reflow slide while dragging", () => {
    expect(pinnedRestX(2, 2, { from: 1, hover: 3 })).toBe(-PINNED_TILE_STEP);
    expect(pinnedRestX(4, 2, { from: 1, hover: 3 })).toBe(2 * PINNED_TILE_STEP);
  });

  // The no-jump guarantee: where every tile sits on screen just before the
  // drop commits equals where it sits once the new order renders.
  it("leaves every tile where it was when the dropped order commits", () => {
    const visual = ["a", "b", "c", "d", "e"];
    const mountOrders = [visual, ["e", "c", "a", "d", "b"], ["b", "a", "e", "d", "c"]];
    for (const mounted of mountOrders) {
      for (let from = 0; from < visual.length; from++) {
        for (let hover = 0; hover < visual.length; hover++) {
          const drag = { from, hover };
          const after = moveTo(visual, from, hover);
          const render = pinnedRenderOrder(mounted, after);
          expect(render).toBe(mounted);
          for (const id of visual) {
            const renderIndex = mounted.indexOf(id);
            const slotBefore = visual.indexOf(id);
            const before =
              slotBefore === from
                ? pinnedRestX(from, renderIndex, null) + pinnedSettleOffset(from, hover)
                : pinnedRestX(slotBefore, renderIndex, drag);
            expect(pinnedRestX(after.indexOf(id), renderIndex, null)).toBe(before);
          }
        }
      }
    }
  });
});

describe("clampDragDx", () => {
  it("passes a drag inside the strip through", () => {
    expect(clampDragDx(50, 1, 4)).toBe(50);
  });

  it("stops half a tile past either end", () => {
    expect(clampDragDx(-1000, 1, 4)).toBe(-1.5 * PINNED_TILE_STEP);
    expect(clampDragDx(1000, 1, 4)).toBe(2.5 * PINNED_TILE_STEP);
  });

  it("still lands on the end slots", () => {
    expect(dropIndex(clampDragDx(-1000, 2, 4), PINNED_TILE_STEP, 2, 4)).toBe(0);
    expect(dropIndex(clampDragDx(1000, 2, 4), PINNED_TILE_STEP, 2, 4)).toBe(3);
  });
});
