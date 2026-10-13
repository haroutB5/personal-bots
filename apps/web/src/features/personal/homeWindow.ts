/**
 * Fixed-height windowing for the Bots home's rows (1.67.0, the perf round).
 *
 * The home draws one 72 px row per chat. Drawn in full, the fixture's 60 chats
 * cost the list about a thousand DOM nodes, which QA's interleaved compare
 * read as a regression against 1.66.36 (DOM nodes 1446 vs 601, list-scroll fps
 * 38-42 against 54, and a longer task on every tap that touched the list). The
 * rows are a fixed height, so which rows the screen must have is a pure
 * function of the scroll offset: draw the rows the scroller shows plus a band
 * of overscan either side, and stand in for the rest with two spacer <li>s
 * whose heights keep the list's total height - and with it the scroll
 * position - exactly what it was. The list's own box never changes size, so a
 * scroller that restores its position (the kept list on Back) lands on the
 * same pixel it left.
 *
 * This module is pure. The DOM side (finding the scroller, listening to it,
 * the wide-viewport reveal) is `useHomeWindow`.
 */

/** One row, exactly: `h-[72px]` (HomeChatRow). The separator is a pseudo-element, so it takes no space. */
export const HOME_ROW_PITCH = 72;

/**
 * Rows drawn beyond each edge of the visible band. A 390 px phone shows about
 * eight rows, so this leaves two screens of travel in either direction before
 * a fling could outrun the drawn rows.
 */
export const HOME_ROW_OVERSCAN = 8;

/** Rows the very first paint draws, before any layout could be measured. */
const FIRST_PAINT_ROWS = 8;

export interface HomeWindowRange {
  /** First drawn row index, inclusive. */
  readonly start: number;
  /** One past the last drawn row. */
  readonly end: number;
}

export interface HomeWindowInput {
  /** Total rows in the list. */
  readonly count: number;
  /** Measured row pitch (72, unless a measurement says otherwise). */
  readonly pitch: number;
  /** Pixels of the list that sit above the scroller's top edge. */
  readonly hiddenAbove: number;
  /** The scroller's own height. */
  readonly viewport: number;
  readonly overscan: number;
  /**
   * The slice drawn a moment ago. Given it, the window only moves when the
   * visible band gets within HYSTERESIS_ROWS of an edge - see below.
   */
  readonly previous?: HomeWindowRange | null;
  /**
   * Which way the person is scrolling, when the window re-anchors: the band is
   * kept wide on the side being scrolled towards and narrow behind, so a
   * swipe's own travel is usually inside the slice already.
   */
  readonly direction?: "up" | "down" | null | undefined;
}

/**
 * How close to an edge of the drawn slice the visible band is allowed to come
 * before the slice moves, in rows. This is the difference between a smooth
 * scroll and a slow one: every move of the slice takes rows out of the DOM and
 * puts rows back. Previously global wildcard sibling rules made a structural
 * change restyle hundreds of elements. Those rules now use non-first-child
 * selectors, but replacing a row still mounts its content and animation
 * layers. Keeping the slice steady avoids that work on every 72 px of travel.
 */
const HYSTERESIS_ROWS = 4;

function clampIndex(index: number, count: number): number {
  if (index < 0) return 0;
  if (index > count) return count;
  return index;
}

/** The slice the first frame draws, before the layout is known. */
export function firstHomeWindow(
  count: number,
  overscan: number = HOME_ROW_OVERSCAN,
): HomeWindowRange {
  // The first slice begins at zero: there are no rows above it to overscan.
  return { start: 0, end: Math.min(Math.max(0, count), overscan + FIRST_PAINT_ROWS) };
}

/**
 * The slice to draw for one scroll position: the visible band plus `overscan`
 * rows either side, moved only when the band threatens to leave the slice
 * (HYSTERESIS_ROWS). `hiddenAbove` is measured from the list's own box (which
 * never moves) rather than accumulated from scroll offsets, so a restored
 * scroll reads the same slice it read before. With `previous` given, a scroll
 * that stays inside the slice returns the same slice by identity, and the list
 * touches no DOM at all.
 */
export function homeWindowRange(input: HomeWindowInput): HomeWindowRange {
  const count = Math.max(0, Math.floor(input.count));
  if (count === 0) return { start: 0, end: 0 };
  const pitch = input.pitch > 0 ? input.pitch : HOME_ROW_PITCH;
  const above = Math.max(0, input.hiddenAbove);
  const viewport = Math.max(0, input.viewport);
  // The rows the scroller can show: the one under its top edge through the one
  // under its bottom edge. A list shorter than the scroller draws in full.
  const firstVisible = clampIndex(Math.floor(above / pitch), count);
  const lastVisible = clampIndex(
    Math.max(firstVisible + 1, Math.ceil((above + viewport) / pitch)),
    count,
  );
  const previous = input.previous ?? null;
  // The anchor's bands: the direction being scrolled towards keeps the wide
  // side, so the swipe travels inside the slice rather than over its edge.
  const near = HYSTERESIS_ROWS;
  const far = Math.max(near, 2 * input.overscan - near);
  const anchorStart = input.direction === "down" ? firstVisible - near : firstVisible - far;
  const anchorEnd = input.direction === "down" ? lastVisible + far : lastVisible + near;
  const anchor =
    input.direction === "up" || input.direction === "down"
      ? { start: anchorStart, end: anchorEnd }
      : { start: firstVisible - input.overscan, end: lastVisible + input.overscan };
  const keep =
    previous !== null &&
    (previous.start === 0 || firstVisible - previous.start >= HYSTERESIS_ROWS) &&
    (previous.end === count || previous.end - lastVisible >= HYSTERESIS_ROWS);
  const start = clampIndex(keep ? previous!.start : anchor.start, count);
  const end = clampIndex(Math.max(keep ? previous!.end : anchor.end, start + 1), count);
  return { start, end };
}

/** Whether a remembered slice has shrunk past the list's new length. */
export function clampHomeWindow(range: HomeWindowRange, count: number): HomeWindowRange {
  const total = Math.max(0, Math.floor(count));
  const end = clampIndex(range.end, total);
  const start = clampIndex(Math.min(range.start, end), total);
  if (start === end && end > 0) {
    // The slice fell clean off a shrunken list (a filter, a search): draw its
    // top again, at the size the slice was. The layout effect that follows
    // measures for real on the same commit.
    return { start: 0, end: Math.min(total, Math.max(1, range.end - range.start)) };
  }
  return start === range.start && end === range.end ? range : { start, end };
}

export function sameHomeWindow(a: HomeWindowRange, b: HomeWindowRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/** Heights of the two spacers that stand in for the undrawn rows. */
export function homeWindowSpacers(
  range: HomeWindowRange,
  count: number,
  pitch: number = HOME_ROW_PITCH,
): { readonly above: number; readonly below: number } {
  const total = Math.max(0, Math.floor(count));
  return {
    above: range.start * pitch,
    below: Math.max(0, total - range.end) * pitch,
  };
}
