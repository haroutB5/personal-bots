import { describe, expect, it } from "vite-plus/test";

import {
  classifyRelease,
  DRAG_SLOP_DP,
  dropIndex,
  moveTo,
  PINNED_TILE_STEP,
  reorderByDrag,
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
