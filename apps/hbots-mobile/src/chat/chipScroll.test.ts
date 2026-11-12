import { describe, expect, it } from "vite-plus/test";
import { chipScrollX } from "./chipScroll";

const viewportWidth = 360;
const contentWidth = 900;

describe("chipScrollX", () => {
  it("leaves the first chip at the start", () => {
    expect(
      chipScrollX({
        chipX: 12,
        chipWidth: 60,
        currentX: 0,
        viewportWidth,
        contentWidth,
      }),
    ).toBe(0);
  });

  it("scrolls the last chip fully in with a margin", () => {
    expect(
      chipScrollX({
        chipX: 820,
        chipWidth: 70,
        currentX: 0,
        viewportWidth,
        contentWidth,
      }),
    ).toBe(540);
  });

  it("keeps the current x when the chip is already visible", () => {
    expect(
      chipScrollX({
        chipX: 120,
        chipWidth: 60,
        currentX: 100,
        viewportWidth,
        contentWidth,
      }),
    ).toBe(100);
  });

  it("returns zero when the content is narrower than the viewport", () => {
    expect(
      chipScrollX({
        chipX: 12,
        chipWidth: 60,
        currentX: 0,
        viewportWidth,
        contentWidth: 300,
      }),
    ).toBe(0);
  });

  it("clamps a right-edge scroll to the content", () => {
    expect(
      chipScrollX({
        chipX: 880,
        chipWidth: 60,
        currentX: 400,
        viewportWidth,
        contentWidth,
      }),
    ).toBe(540);
  });
});
