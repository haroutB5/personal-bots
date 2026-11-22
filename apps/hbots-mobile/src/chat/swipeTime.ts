/** Fallback label height (dp) before the time label has laid out once. */
export const SWIPE_TIME_LABEL_HEIGHT = 18;

/**
 * Where the swipe-revealed sent time sits in its row: level with the finger,
 * so it is on screen even when the message is taller than the screen, and
 * clamped inside the row. `touchY` and `rowTop` are page coordinates.
 */
export function swipeTimeTop(input: {
  readonly touchY: number;
  readonly rowTop: number;
  readonly rowHeight: number;
  readonly labelHeight: number;
}): number {
  const { touchY, rowTop, rowHeight, labelHeight } = input;
  const max = Math.max(0, rowHeight - labelHeight);
  const top = touchY - rowTop - labelHeight / 2;
  if (!Number.isFinite(top)) return 0;
  return Math.min(max, Math.max(0, top));
}
