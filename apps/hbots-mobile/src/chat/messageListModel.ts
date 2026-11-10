import type { MarkdownCell, MarkdownTable } from "./markdown";

export const TABLE_CELL_MIN_WIDTH = 72;
export const TABLE_CELL_MAX_WIDTH = 200;

/**
 * Width estimates for the 13 px table font, rounded up: a regular glyph
 * advances about 7 px and a bold one about 9 px. The header row is bold, and
 * so is any bold run in a body cell.
 */
const TABLE_GLYPH_WIDTH = 7;
const TABLE_BOLD_GLYPH_WIDTH = 9;
const TABLE_CELL_PADDING = 20;

function cellTextLength(cell: MarkdownCell | undefined): number {
  return (
    cell?.spans.reduce(
      (total, span) => total + (span.kind === "file" ? span.label.length : span.text.length),
      0,
    ) ?? 0
  );
}

function longestWordLength(cell: MarkdownCell | undefined): number {
  let longest = 0;
  for (const word of cell?.text.split(/\s+/u) ?? []) {
    longest = Math.max(longest, word.length);
  }
  return longest;
}

/**
 * A column is as wide as its longest cell, and at least as wide as its longest
 * single word so a word never breaks mid-word; longer text wraps at spaces.
 * The table scrolls sideways, so wider columns are fine.
 */
export function tableColumnWidths(table: MarkdownTable): ReadonlyArray<number> {
  return table.header.map((headerCell, column) => {
    let widest = 0;
    const cells = [headerCell, ...table.rows.map((row) => row[column])];
    for (const [rowIndex, cell] of cells.entries()) {
      const bold = rowIndex === 0 || cell?.spans.some((span) => span.kind === "bold") === true;
      widest = Math.max(
        widest,
        cellTextLength(cell) * TABLE_GLYPH_WIDTH,
        longestWordLength(cell) * (bold ? TABLE_BOLD_GLYPH_WIDTH : TABLE_GLYPH_WIDTH),
      );
    }
    return Math.min(
      TABLE_CELL_MAX_WIDTH,
      Math.max(TABLE_CELL_MIN_WIDTH, widest + TABLE_CELL_PADDING),
    );
  });
}

/**
 * The data index of a feed row. The list renders its rows reversed, so the
 * index used by `scrollToIndex` is the mirror of the transcript position.
 */
export function scrollIndexForItem(
  rows: ReadonlyArray<{ readonly key: string }>,
  itemId: string,
): number | null {
  const index = rows.findIndex((row) => row.key === itemId);
  return index < 0 ? null : rows.length - 1 - index;
}

/**
 * A mostly horizontal drag replies to the message, unless the touch began
 * inside a horizontal scroller such as a wide table.
 */
export function claimsReplySwipe(dx: number, dy: number, beganInScroller: boolean): boolean {
  return !beganInScroller && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4;
}

/** Movement beyond this many pixels is a drag, not a long press. */
export const LONG_PRESS_SLOP = 10;

/**
 * A still finger opens the message menu, except when the touch began on a
 * link or a choice button: those own the press, as they did when the body was
 * a Pressable.
 */
export function opensMessageMenu(
  startedOnInteractive: boolean,
  dx: number,
  dy: number,
  slop: number = LONG_PRESS_SLOP,
): boolean {
  return !startedOnInteractive && Math.abs(dx) <= slop && Math.abs(dy) <= slop;
}
