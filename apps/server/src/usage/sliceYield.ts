// @effect-diagnostics nodeBuiltinImport:off
/**
 * Time slicing for long synchronous loops on the server's main thread.
 *
 * A loop over a few hundred thousand transcript records is only a few hundred
 * milliseconds of work, but done in one go it holds the event loop for that
 * long: sockets, SQLite writes and every client wait behind it. `due` is a
 * cheap clock check to make every few dozen iterations; once the slice budget
 * is spent, `yieldNow` lets everything queued run and starts a new slice.
 *
 * @module sliceYield
 */
import * as NodeTimersPromises from "node:timers/promises";

/** A slice of at most about this long keeps a block well under 50 ms. */
export const DEFAULT_SLICE_BUDGET_MS = 8;

export interface SliceYield {
  /** True once the current slice has used its budget. Cheap: one clock read. */
  readonly due: () => boolean;
  /** Runs everything waiting on the event loop, then starts a new slice. */
  readonly yieldNow: () => Promise<void>;
}

export function makeSliceYield(budgetMs: number = DEFAULT_SLICE_BUDGET_MS): SliceYield {
  let sliceStartMs = performance.now();
  return {
    due: () => performance.now() - sliceStartMs >= budgetMs,
    yieldNow: async () => {
      await NodeTimersPromises.setImmediate();
      sliceStartMs = performance.now();
    },
  };
}
