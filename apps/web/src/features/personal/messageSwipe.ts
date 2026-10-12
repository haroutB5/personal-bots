import { EDGE_WIDTH_PX } from "./edgeSwipeBack";
import { LONG_PRESS_SLOP_PX } from "./useLongPress";

/**
 * Swiping a message sideways to see when it was sent: the owner's messages go
 * left, a bot's go right, each towards the empty side of the screen. The pure
 * parts live here (which way a move is going, how far the message follows, how
 * visible the time is); useMessageSwipe.ts drives them from the pointer.
 */

/** Movement before a touch decides between scrolling and swiping: the long press's slop. */
export const SWIPE_LOCK_PX = LONG_PRESS_SLOP_PX;
/** A swipe has to be this much more sideways than up or down; scrolling wins every tie. */
export const SWIPE_AXIS_RATIO = 1.5;
/** The most a message follows the finger (the room the time needs beside it). */
export const SWIPE_MAX_REVEAL_PX = 68;
/** The time starts to show after this much travel and is fully there at `SWIPE_FULL_REVEAL_PX`. */
export const SWIPE_FIRST_SHOWN_PX = 10;
export const SWIPE_FULL_REVEAL_PX = 44;
/** The message springs back over this long. */
export const SWIPE_RELEASE_MS = 220;

export type SwipeSide = "start" | "end";

/**
 * What a move of (dx, dy) from the touch-down point is: still too small to say
 * (null), a scroll ("y") or a swipe ("x"). Up and down wins unless the move is
 * clearly sideways.
 */
export function swipeAxis(dx: number, dy: number): "x" | "y" | null {
  const across = Math.abs(dx);
  const along = Math.abs(dy);
  if (Math.max(across, along) < SWIPE_LOCK_PX) return null;
  return across > along * SWIPE_AXIS_RATIO ? "x" : "y";
}

/** Whether a sideways move goes the way this message swipes: left for `end`, right for `start`. */
export function swipeGoesTheWay(dx: number, align: SwipeSide): boolean {
  return align === "end" ? dx < 0 : dx > 0;
}

/**
 * Where the message sits for a finger that has moved `dx` sideways: signed,
 * 0 at the lock, about 1:1 at first, then ever stiffer towards
 * `SWIPE_MAX_REVEAL_PX`, which it never reaches. Moving the wrong way, or back
 * past the start, stays at 0.
 */
export function swipeOffset(dx: number, align: SwipeSide): number {
  if (!swipeGoesTheWay(dx, align)) return 0;
  const travel = Math.max(0, Math.abs(dx) - SWIPE_LOCK_PX);
  const reveal = SWIPE_MAX_REVEAL_PX * Math.tanh(travel / SWIPE_MAX_REVEAL_PX);
  return align === "end" ? 0 - reveal : reveal;
}

/** How visible the time is (0 to 1) once the message has moved `distance` px. */
export function swipeTimeOpacity(distance: number): number {
  const shown =
    (Math.abs(distance) - SWIPE_FIRST_SHOWN_PX) / (SWIPE_FULL_REVEAL_PX - SWIPE_FIRST_SHOWN_PX);
  return Math.min(1, Math.max(0, shown));
}

/** The edge swipe back owns a touch that starts in its strip; a message never sees it. */
export function startsInEdgeZone(clientX: number): boolean {
  return clientX < EDGE_WIDTH_PX;
}

/** Sideways overflow past the box that counts as a scroller: sub-pixel rounding slop. */
export const SIDEWAYS_SCROLL_SLOP_PX = 1;

/** Whether an overflow-x value lets a finger pan the box sideways. */
export function scrollsSideways(overflowX: string): boolean {
  return overflowX === "auto" || overflowX === "scroll";
}

/** What the walk up from a touch reads of each box: the two scroll widths and the way up. */
export interface SidewaysScrollBox {
  readonly parentElement: SidewaysScrollBox | null;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/**
 * Whether a touch that started on `touched` landed inside something that
 * scrolls sideways within `boundary` (the swiping row): a table or a code
 * block too wide for the screen keeps its own touch, so a drag pans it both
 * ways and the message's swipe never takes it. `overflow-x: hidden` or `clip`
 * is not a scroller a finger can pan, and neither is a box whose content fits
 * (nothing to scroll). The walk stops at `boundary`, looked at too: only what
 * sits inside the row can claim the touch.
 */
export function startsInSidewaysScroller(
  touched: SidewaysScrollBox | null,
  boundary: SidewaysScrollBox | null,
): boolean {
  for (
    let box: SidewaysScrollBox | null | undefined = touched;
    box != null;
    box = box.parentElement
  ) {
    const style = window.getComputedStyle(box as unknown as Element);
    if (
      scrollsSideways(style.overflowX) &&
      box.scrollWidth > box.clientWidth + SIDEWAYS_SCROLL_SLOP_PX
    ) {
      return true;
    }
    if (box === boundary) return false;
  }
  return false;
}
