import { describe, expect, it } from "vite-plus/test";

import { keyboardRemainder } from "./keyboardInset";

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
