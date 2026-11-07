import { describe, expect, it } from "vite-plus/test";

import { keyboardRemainder, nextBaseHeight } from "./keyboardInset";

describe("keyboardRemainder", () => {
  it("returns the whole keyboard when the window did not shrink", () => {
    expect(keyboardRemainder({ baseHeight: 785, frameHeight: 785, keyboardHeight: 299 })).toBe(299);
  });

  it("returns nothing when the window already shrank by the keyboard", () => {
    expect(keyboardRemainder({ baseHeight: 785, frameHeight: 486, keyboardHeight: 299 })).toBe(0);
  });

  it("returns only the part the window resize did not cover", () => {
    expect(keyboardRemainder({ baseHeight: 785, frameHeight: 600, keyboardHeight: 299 })).toBe(114);
  });

  it("ignores a hidden keyboard and an unmeasured container", () => {
    expect(keyboardRemainder({ baseHeight: 785, frameHeight: 785, keyboardHeight: 0 })).toBe(0);
    expect(keyboardRemainder({ baseHeight: 0, frameHeight: 0, keyboardHeight: 299 })).toBe(0);
  });
});

describe("nextBaseHeight", () => {
  it("keeps the closed height across a hide with no new layout, so the second open is padded", () => {
    // First open: measured closed at 785, edge-to-edge window stays 785.
    let base = nextBaseHeight({ previous: null, layoutHeight: 785, keyboardOpen: false });
    expect(
      keyboardRemainder({ baseHeight: base ?? 0, frameHeight: 785, keyboardHeight: 299 }),
    ).toBe(299);
    // Keyboard hides: edge-to-edge sends no layout, so base must survive.
    // Second open, still no layout event.
    expect(base).toBe(785);
    expect(
      keyboardRemainder({ baseHeight: base ?? 0, frameHeight: 785, keyboardHeight: 299 }),
    ).toBe(299);
    // A layout while the keyboard is open never replaces the closed height.
    base = nextBaseHeight({ previous: base, layoutHeight: 486, keyboardOpen: true });
    expect(base).toBe(785);
  });

  it("takes a new closed-keyboard layout, such as a rotation", () => {
    expect(nextBaseHeight({ previous: 785, layoutHeight: 360, keyboardOpen: false })).toBe(360);
  });
});
