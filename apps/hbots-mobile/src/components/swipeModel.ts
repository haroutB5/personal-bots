/** Where a swipeable row rests: slid left (trailing actions shown), slid right (leading actions) or shut. */
export type SwipeRest = "closed" | "left" | "right";

export const SWIPE_ACTION_WIDTH = 88;
export const SWIPE_CLAIM_SLOP_PX = 8;
export const SWIPE_SETTLE_FRACTION = 0.45;

export interface SwipeReach {
  /** Pixels the row can slide right, which is the width of the leading actions. */
  readonly leading: number;
  /** Pixels the row can slide left, which is the width of the trailing actions. */
  readonly trailing: number;
}

export function swipeReach(leadingCount: number, trailingCount: number): SwipeReach {
  return {
    leading: leadingCount * SWIPE_ACTION_WIDTH,
    trailing: trailingCount * SWIPE_ACTION_WIDTH,
  };
}

/** The row's translation at rest. Left is negative. */
export function restOffset(rest: SwipeRest, reach: SwipeReach): number {
  switch (rest) {
    case "closed":
      return 0;
    case "left":
      return -reach.trailing;
    case "right":
      return reach.leading;
    default: {
      const unreachable: never = rest;
      return unreachable;
    }
  }
}

/** The row follows the finger but never slides past the actions it has. */
export function dragOffset(rest: SwipeRest, dx: number, reach: SwipeReach): number {
  const offset = Math.max(-reach.trailing, Math.min(reach.leading, restOffset(rest, reach) + dx));
  return offset === 0 ? 0 : offset;
}

/** Where the row comes to rest when the finger lifts: open past 45% of the actions' width. */
export function settleRest(offset: number, reach: SwipeReach): SwipeRest {
  if (offset < 0 && reach.trailing > 0 && -offset > reach.trailing * SWIPE_SETTLE_FRACTION) {
    return "left";
  }
  if (offset > 0 && reach.leading > 0 && offset > reach.leading * SWIPE_SETTLE_FRACTION) {
    return "right";
  }
  return "closed";
}

/** Only a mostly horizontal drag takes the touch, so a vertical one still scrolls the list. */
export function claimsSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > SWIPE_CLAIM_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.2;
}
