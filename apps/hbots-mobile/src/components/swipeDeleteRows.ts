/**
 * The armed swipe rows of the mounted screen. A row is armed at most until
 * another row arms or a touch lands outside it; the screen calls
 * `touchOutsideSwipeRows` from its root touch handler so a tap on empty space
 * closes it too.
 */
import { armedRowsAfterArm, armedRowsAfterTouch } from "./swipeDeleteModel";

const closeByRow = new Map<string, () => void>();
let armed = new Set<string>();
let lastRowTouchAt = 0;

/** Registers one row's close callback; returns the unregister function. */
export function registerSwipeRow(id: string, close: () => void): () => void {
  closeByRow.set(id, close);
  return () => {
    closeByRow.delete(id);
    armed.delete(id);
  };
}

function closeRowsExcept(keep: ReadonlySet<string>): void {
  for (const rowId of armed) {
    if (!keep.has(rowId)) closeByRow.get(rowId)?.();
  }
  armed = new Set(keep);
}

/** A touch reached one row: keep that row armed and close the rest. */
export function touchSwipeRow(id: string): void {
  lastRowTouchAt = Date.now();
  closeRowsExcept(armedRowsAfterTouch(armed, id));
}

/** A row armed itself: close every other row. */
export function armSwipeRow(id: string): void {
  closeRowsExcept(armedRowsAfterArm(armed, id));
}

/** The row closed on its own (commit, right swipe or Delete). */
export function disarmSwipeRow(id: string): void {
  armed.delete(id);
}

/** Close every armed row, e.g. on a scroll, a sheet or a navigation. */
export function closeAllSwipeRows(): void {
  closeRowsExcept(new Set());
}

/**
 * A touch on the screen root. Touches inside a row call `touchSwipeRow`
 * first, in the same event, and must not close their own row.
 */
export function touchOutsideSwipeRows(): void {
  if (Date.now() - lastRowTouchAt < 100) return;
  closeAllSwipeRows();
}
