/** The pinned strip's pure reorder maths, kept out of the gesture code. */

/** One tile plus the strip's gap, in dp. */
export const PINNED_TILE_STEP = 82;

/** A lift that moves less than this is a long press, not a drag. */
export const DRAG_SLOP_DP = 8;

/** What a released lift does: open the actions sheet, reorder, or nothing. */
export function classifyRelease(dx: number, moved: boolean): "sheet" | "reorder" | "none" {
  if (!moved) return "sheet";
  return Math.abs(dx) > DRAG_SLOP_DP ? "reorder" : "none";
}

/** Where a drag that started at `from` should land, clamped to the strip. */
export function dropIndex(dx: number, tileWidth: number, from: number, count: number): number {
  if (count <= 0) return 0;
  const target = from + Math.round(dx / Math.max(1, tileWidth));
  return Math.max(0, Math.min(count - 1, target));
}

/**
 * The list after dragging `botId` by `dx`. The index is looked up in the list
 * handed in, so a second drag uses the order the first one saved.
 */
export function reorderByDrag(
  ids: ReadonlyArray<string>,
  botId: string,
  dx: number,
  tileWidth = PINNED_TILE_STEP,
): ReadonlyArray<string> {
  const from = ids.indexOf(botId);
  if (from < 0) return [...ids];
  return moveTo(ids, from, dropIndex(dx, tileWidth, from, ids.length));
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
