import { describe, expect, it } from "vite-plus/test";

import { dropIndex, moveTo } from "./pinnedOrderModel.ts";

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
