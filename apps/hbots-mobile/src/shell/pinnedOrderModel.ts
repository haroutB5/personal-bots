/** The pinned strip's pure reorder maths, kept out of the gesture code. */

/** One tile plus the strip's gap, in dp. */
export const PINNED_TILE_STEP = 82;

/** Where a drag that started at `from` should land, clamped to the strip. */
export function dropIndex(dx: number, tileWidth: number, from: number, count: number): number {
  if (count <= 0) return 0;
  const target = from + Math.round(dx / Math.max(1, tileWidth));
  return Math.max(0, Math.min(count - 1, target));
}

/** The list with the entry at `from` moved to `to`; everything else keeps its order. */
export function moveTo<T>(ids: ReadonlyArray<T>, from: number, to: number): ReadonlyArray<T> {
  if (from < 0 || from >= ids.length) return [...ids];
  const target = Math.max(0, Math.min(ids.length - 1, to));
  if (target === from) return [...ids];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...ids];
  next.splice(target, 0, moved);
  return next;
}
