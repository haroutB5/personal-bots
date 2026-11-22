import { describe, expect, it } from "vite-plus/test";

import { swipeTimeTop } from "./swipeTime";

const row = { rowTop: 100, rowHeight: 3000, labelHeight: 20 };

describe("swipeTimeTop", () => {
  it("centres the label on the finger inside a tall row", () => {
    expect(swipeTimeTop({ ...row, touchY: 1600 })).toBe(1490);
  });

  it("never goes above the row's top", () => {
    expect(swipeTimeTop({ ...row, touchY: 105 })).toBe(0);
    expect(swipeTimeTop({ ...row, touchY: 20 })).toBe(0);
  });

  it("never goes below the row's bottom", () => {
    expect(swipeTimeTop({ ...row, touchY: 3098 })).toBe(2980);
    expect(swipeTimeTop({ ...row, touchY: 9000 })).toBe(2980);
  });

  it("keeps a label taller than its row at the top", () => {
    expect(swipeTimeTop({ rowTop: 0, rowHeight: 10, labelHeight: 20, touchY: 5 })).toBe(0);
  });

  it("falls back to the top when a measurement is missing", () => {
    expect(swipeTimeTop({ ...row, touchY: Number.NaN })).toBe(0);
  });
});
