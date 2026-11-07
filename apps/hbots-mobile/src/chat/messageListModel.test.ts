import { describe, expect, it } from "vite-plus/test";

import { scrollIndexForItem } from "./messageListModel";

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
