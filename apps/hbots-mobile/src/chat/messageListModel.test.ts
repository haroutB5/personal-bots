import { describe, expect, it } from "vite-plus/test";

import type { MarkdownTable } from "./markdown";
import {
  claimsReplySwipe,
  LONG_PRESS_SLOP,
  opensMessageMenu,
  scrollIndexForItem,
  TABLE_CELL_MAX_WIDTH,
  tableColumnWidths,
} from "./messageListModel";

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

describe("opensMessageMenu", () => {
  it("opens on a still finger that began on the message body", () => {
    expect(opensMessageMenu(false, 0, 0)).toBe(true);
    expect(opensMessageMenu(false, LONG_PRESS_SLOP, -LONG_PRESS_SLOP)).toBe(true);
  });

  it("stays shut when the touch began on a link or a choice button", () => {
    expect(opensMessageMenu(true, 0, 0)).toBe(false);
    expect(opensMessageMenu(true, 2, 3)).toBe(false);
  });

  it("stays shut when the finger moved past the slop", () => {
    expect(opensMessageMenu(false, LONG_PRESS_SLOP + 1, 0)).toBe(false);
    expect(opensMessageMenu(false, 0, -LONG_PRESS_SLOP - 1)).toBe(false);
  });
});

function tableOf(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): MarkdownTable {
  const cell = (text: string) => ({ text, spans: [{ kind: "text" as const, text }] });
  return {
    header: header.map(cell),
    aligns: header.map(() => "left" as const),
    rows: rows.map((row) => row.map(cell)),
  };
}

describe("tableColumnWidths", () => {
  it("keeps a bold header word whole instead of breaking it mid-word", () => {
    const [width] = tableColumnWidths(tableOf(["Command"], [["ls"]]));
    // The 13 px bold header glyph advances about 9 px, plus 20 px cell padding.
    expect(width).toBeGreaterThanOrEqual(7 * 9 + 20);
  });

  it("holds the maximum width for a word longer than the cap", () => {
    const [width] = tableColumnWidths(tableOf(["Command"], [["x".repeat(120)]]));
    expect(width).toBe(TABLE_CELL_MAX_WIDTH);
  });
});
