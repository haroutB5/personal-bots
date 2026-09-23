import { describe, expect, it } from "vite-plus/test";

import { revealDelta } from "./sidebarReveal";

describe("revealDelta", () => {
  it("leaves a fully visible row alone, even flush with an edge", () => {
    expect(revealDelta(100, 188, 0, 800, 12)).toBe(0);
    expect(revealDelta(0, 88, 0, 800, 12)).toBe(0);
    expect(revealDelta(712, 800, 0, 800, 12)).toBe(0);
  });

  it("scrolls up to a row above the view, with the margin", () => {
    expect(revealDelta(-300, -212, 0, 800, 12)).toBe(-312);
    // Partly cut off at the top.
    expect(revealDelta(-40, 48, 0, 800, 12)).toBe(-52);
  });

  it("scrolls down to a row below the view, with the margin", () => {
    expect(revealDelta(1000, 1088, 0, 800, 12)).toBe(300);
    // Partly cut off at the bottom.
    expect(revealDelta(760, 848, 0, 800, 12)).toBe(60);
  });

  it("aligns the start of a row taller than the view", () => {
    expect(revealDelta(900, 1900, 0, 800, 12)).toBe(888);
  });

  it("works in viewport coordinates, not only from zero", () => {
    expect(revealDelta(40, 128, 56, 700, 12)).toBe(-28);
  });
});
