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
 * A send whose message the transcript already shows is that message, not a pending bubble. The
 * pending row stays until then, so removing it never leaves a frame with no bubble at all.
 */
export function pendingNotArrived<P extends { readonly id: string }>(
  pending: ReadonlyArray<P>,
  arrivedIds: ReadonlySet<string>,
): ReadonlyArray<P> {
  return pending.filter((message) => !arrivedIds.has(message.id));
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

/** A second tap within this long of the first starts text selection. */
export const DOUBLE_TAP_MS = 300;
/** The two taps of a double tap land within this many dp of each other. */
export const DOUBLE_TAP_SLOP = 24;
/** A finger held this long is a long press, which opens the message menu. */
export const LONG_PRESS_MS = 350;

export type Point = { readonly x: number; readonly y: number };

export type TouchState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "pressing";
      readonly at: number;
      readonly origin: Point;
      readonly latest: Point;
      /** The touch began on a link, file chip or choice button. */
      readonly interactive: boolean;
      /** Set when this press is the second tap of a double tap. */
      readonly after: { readonly at: number; readonly origin: Point } | null;
    }
  | { readonly kind: "tapped"; readonly at: number; readonly origin: Point };

export type TouchEvent =
  | { readonly kind: "down"; readonly at: number; readonly point: Point }
  | { readonly kind: "move"; readonly point: Point }
  | { readonly kind: "interactive" }
  | { readonly kind: "up"; readonly at: number }
  | { readonly kind: "cancel" }
  | { readonly kind: "held" };

export type TouchEffect =
  | { readonly kind: "none" }
  | { readonly kind: "menu" }
  | { readonly kind: "select"; readonly point: Point };

const NO_EFFECT: TouchEffect = { kind: "none" };
const IDLE: TouchState = { kind: "idle" };

/**
 * One finger on a bot message. A still tap becomes `tapped`; a second tap soon
 * and near enough gives `select`; a held finger gives `menu`; anything that
 * moves, lands on a link or is cancelled gives nothing. Nothing waits for a
 * single tap, so links stay immediate.
 */
export function touchStep(
  state: TouchState,
  event: TouchEvent,
): { readonly state: TouchState; readonly effect: TouchEffect } {
  switch (event.kind) {
    case "down": {
      const after =
        state.kind === "tapped" &&
        event.at - state.at <= DOUBLE_TAP_MS &&
        Math.abs(event.point.x - state.origin.x) <= DOUBLE_TAP_SLOP &&
        Math.abs(event.point.y - state.origin.y) <= DOUBLE_TAP_SLOP
          ? { at: state.at, origin: state.origin }
          : null;
      return {
        state: {
          kind: "pressing",
          at: event.at,
          origin: event.point,
          latest: event.point,
          interactive: false,
          after,
        },
        effect: NO_EFFECT,
      };
    }
    case "move":
      if (state.kind !== "pressing") return { state, effect: NO_EFFECT };
      return {
        state: { ...state, latest: event.point },
        effect: NO_EFFECT,
      };
    case "interactive":
      if (state.kind !== "pressing") return { state, effect: NO_EFFECT };
      return { state: { ...state, interactive: true }, effect: NO_EFFECT };
    case "up": {
      if (state.kind !== "pressing") return { state: IDLE, effect: NO_EFFECT };
      const still = opensMessageMenu(
        state.interactive,
        state.latest.x - state.origin.x,
        state.latest.y - state.origin.y,
      );
      if (!still || event.at - state.at >= LONG_PRESS_MS) return { state: IDLE, effect: NO_EFFECT };
      if (state.after !== null) {
        return { state: IDLE, effect: { kind: "select", point: state.latest } };
      }
      return { state: { kind: "tapped", at: event.at, origin: state.origin }, effect: NO_EFFECT };
    }
    case "held": {
      if (state.kind !== "pressing") return { state, effect: NO_EFFECT };
      const opens = opensMessageMenu(
        state.interactive,
        state.latest.x - state.origin.x,
        state.latest.y - state.origin.y,
      );
      return { state: IDLE, effect: opens ? { kind: "menu" } : NO_EFFECT };
    }
    case "cancel":
      return { state: IDLE, effect: NO_EFFECT };
  }
}
