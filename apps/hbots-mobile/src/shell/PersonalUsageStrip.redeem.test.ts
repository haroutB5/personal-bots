import { describe, expect, it } from "vite-plus/test";

import { usageRedeemRow } from "./usageRedeem.ts";

// The state PersonalUsageStrip renders for its Redeem row.
describe("PersonalUsageStrip redeem row", () => {
  it("hides the button and shows the pairing line without providers:manage", () => {
    expect(usageRedeemRow({ availableCount: 1 }, false)).toEqual({
      showButton: false,
      notice: "Pair this device again to redeem resets.",
    });
  });

  it("shows the button and no pairing line with providers:manage", () => {
    expect(usageRedeemRow({ availableCount: 1 }, true)).toEqual({
      showButton: true,
      notice: null,
    });
  });

  it("shows nothing when no credit is banked", () => {
    expect(usageRedeemRow({ availableCount: 0 }, true)).toEqual({
      showButton: false,
      notice: null,
    });
  });
});
