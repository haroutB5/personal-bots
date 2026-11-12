/**
 * The two-step swipe delete. The first left swipe arms the row: it shows
 * Delete with a "Swipe again to delete" hint. A second left swipe past the
 * same threshold commits; a right swipe or a tap elsewhere disarms it.
 */
export type SwipeDelete = { readonly kind: "closed" } | { readonly kind: "armed" };

export type SwipeDeleteGesture =
  | {
      readonly kind: "swipe";
      /** Negative moves left; the distance from where the finger went down. */
      readonly distance: number;
      readonly threshold: number;
    }
  | { readonly kind: "dismiss" };

export interface SwipeDeleteResult {
  readonly state: SwipeDelete;
  readonly effect: "none" | "commit";
}

export const CLOSED: SwipeDelete = { kind: "closed" };
export const ARMED: SwipeDelete = { kind: "armed" };

/** An armed row closes after this long without a touch. */
export const SWIPE_ARM_TIMEOUT_MS = 5_000;

/** True once an arm is older than the timeout. */
export function armTimedOut(armedAtMs: number, nowMs: number): boolean {
  return nowMs - armedAtMs >= SWIPE_ARM_TIMEOUT_MS;
}

/** The armed rows after a touch: only the row that was touched stays armed. */
export function armedRowsAfterTouch(
  armedRowIds: ReadonlySet<string>,
  touchedId: string,
): ReadonlySet<string> {
  return armedRowIds.has(touchedId) ? new Set([touchedId]) : new Set();
}

/** Arming a row closes every other armed row. */
export function armedRowsAfterArm(
  armedRowIds: ReadonlySet<string>,
  rowId: string,
): ReadonlySet<string> {
  if (armedRowIds.size === 1 && armedRowIds.has(rowId)) return armedRowIds;
  return new Set([rowId]);
}

export function nextSwipeDelete(
  state: SwipeDelete,
  gesture: SwipeDeleteGesture,
): SwipeDeleteResult {
  if (gesture.kind === "dismiss") {
    return { state: CLOSED, effect: "none" };
  }
  if (gesture.distance > 0) {
    return { state: CLOSED, effect: "none" };
  }
  if (gesture.distance > -gesture.threshold) {
    return { state, effect: "none" };
  }
  if (state.kind === "armed") {
    return { state: CLOSED, effect: "commit" };
  }
  return { state: ARMED, effect: "none" };
}
