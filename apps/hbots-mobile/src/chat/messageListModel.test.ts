import { describe, expect, it } from "vite-plus/test";

import { claimsReplySwipe, scrollIndexForItem } from "./messageListModel";

describe("scrollIndexForItem", () => {
  const rows = [{ key: "older" }, { key: "middle" }, { key: "newest" }];

  it("mirrors the transcript position into the reversed list", () => {
    expect(scrollIndexForItem(rows, "newest")).toBe(0);
    expect(scrollIndexForItem(rows, "middle")).toBe(1);
    expect(scrollIndexForItem(rows, "older")).toBe(2);
  });

  it("returns null for a row the list does not hold", () => {
    expect(scrollIndexForItem(rows, "secret:missing")).toBeNull();
  });
});

describe("claimsReplySwipe", () => {
  it("takes a horizontal drag that began on the message", () => {
    expect(claimsReplySwipe(40, 8, false)).toBe(true);
  });

  it("leaves a vertical drag to the list", () => {
    expect(claimsReplySwipe(8, 40, false)).toBe(false);
  });

  it("leaves a horizontal drag that began in a scroller", () => {
    expect(claimsReplySwipe(60, 2, true)).toBe(false);
  });

  it("ignores a drag under the slop", () => {
    expect(claimsReplySwipe(9, 0, false)).toBe(false);
  });

  it("ignores a drag that is more diagonal than horizontal", () => {
    expect(claimsReplySwipe(10, 9, false)).toBe(false);
  });
});
