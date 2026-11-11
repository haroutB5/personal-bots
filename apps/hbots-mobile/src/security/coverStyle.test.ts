import { describe, expect, it } from "vite-plus/test";

import { underLock } from "./coverStyle";

describe("the app under the lock", () => {
  it("is not displayed and is hidden from accessibility while covered", () => {
    expect(underLock(true)).toEqual({
      display: "none",
      importantForAccessibility: "no-hide-descendants",
      accessibilityElementsHidden: true,
    });
  });

  it("is displayed normally when the lock is open", () => {
    expect(underLock(false)).toEqual({
      display: "flex",
      importantForAccessibility: "auto",
      accessibilityElementsHidden: false,
    });
  });
});
