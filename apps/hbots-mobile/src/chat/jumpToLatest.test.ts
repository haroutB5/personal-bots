import { describe, expect, it } from "vite-plus/test";
import { JUMP_THRESHOLD, jumpVisible } from "./jumpToLatest";

describe("jumpVisible", () => {
  it("stays hidden at the newest message", () => {
    expect(jumpVisible(0)).toBe(false);
  });

  it("stays hidden at the threshold", () => {
    expect(jumpVisible(JUMP_THRESHOLD)).toBe(false);
  });

  it("shows just past the threshold", () => {
    expect(jumpVisible(JUMP_THRESHOLD + 1)).toBe(true);
  });

  it("shows while scrolled far up", () => {
    expect(jumpVisible(640)).toBe(true);
  });
});
