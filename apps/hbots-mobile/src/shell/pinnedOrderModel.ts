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

/** A live drag: the slot the lifted tile came from and the slot it hovers over. */
export interface PinnedDrag {
  readonly from: number;
  readonly hover: number;
}

/**
 * How far the tile in visual slot `index` slides sideways while another tile is
 * dragged from `from` to the hover slot `hover`, so a gap opens at the hover slot.
 * The dragged tile itself follows the finger and returns 0 here.
 */
export function pinnedShiftFor(
  index: number,
  from: number,
  hover: number,
  step = PINNED_TILE_STEP,
): number {
  if (index === from || from === hover) return 0;
  if (hover > from && index > from && index <= hover) return -step;
  if (hover < from && index >= hover && index < from) return step;
  return 0;
}

/** The finger offset, kept within half a tile past either end of the strip. */
export function clampDragDx(
  dx: number,
  from: number,
  count: number,
  step = PINNED_TILE_STEP,
): number {
  const min = -from * step - step / 2;
  const max = (Math.max(count, 1) - 1 - from) * step + step / 2;
  return Math.max(min, Math.min(max, dx));
}

/** Where the dragged tile comes to rest, relative to its own slot, when dropped on `hover`. */
export function pinnedSettleOffset(from: number, hover: number, step = PINNED_TILE_STEP): number {
  return (hover - from) * step;
}

/**
 * The strip's mount order: kept while the same bots are pinned, so a reorder
 * moves tiles by translateX only and never re-lays out (no flash on commit).
 * A new set of bots, or `normalize`, takes the visual order.
 */
export function pinnedRenderOrder(
  previous: ReadonlyArray<string>,
  visual: ReadonlyArray<string>,
  normalize = false,
): ReadonlyArray<string> {
  if (normalize) return sameOrder(previous, visual) ? previous : visual;
  const members = new Set(previous);
  const sameMembers =
    previous.length === visual.length &&
    members.size === previous.length &&
    visual.every((id) => members.has(id));
  return sameMembers ? previous : visual;
}

export function sameOrder(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * The translateX that puts a tile mounted at `renderIndex` into visual slot
 * `slot`, plus the reflow slide while another tile is dragged.
 */
export function pinnedRestX(
  slot: number,
  renderIndex: number,
  drag: PinnedDrag | null,
  step = PINNED_TILE_STEP,
): number {
  const base = (slot - renderIndex) * step;
  return drag === null ? base : base + pinnedShiftFor(slot, drag.from, drag.hover, step);
}
