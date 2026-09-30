import { describe, expect, it } from "vite-plus/test";

import { mayClosePressOpenedMenu } from "./pressOpenedMenuGuard";

describe("mayClosePressOpenedMenu", () => {
  it("ignores the outside press made by the finger still holding", () => {
    expect(mayClosePressOpenedMenu("outside-press", Number.POSITIVE_INFINITY, 1_000)).toBe(false);
  });

  it("ignores it just after the lift, then lets a real outside tap close", () => {
    expect(mayClosePressOpenedMenu("outside-press", 1_350, 1_100)).toBe(false);
    expect(mayClosePressOpenedMenu("outside-press", 1_350, 1_400)).toBe(true);
  });

  it("always lets an action or Escape close it", () => {
    expect(mayClosePressOpenedMenu("item-press", Number.POSITIVE_INFINITY, 0)).toBe(true);
    expect(mayClosePressOpenedMenu("escape-key", Number.POSITIVE_INFINITY, 0)).toBe(true);
  });

  it("does nothing for a menu no press opened", () => {
    expect(mayClosePressOpenedMenu("outside-press", 0, 5)).toBe(true);
  });
});
