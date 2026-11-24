/**
 * Coalesces high-frequency touch scroll moves into at most one `Wheel` message
 * per animation frame; call `flush` before any other input to preserve order.
 */
export interface WheelStep {
  readonly x: number;
  readonly y: number;
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface WheelBatcher {
  /** Adds a step; it is sent with the next animation frame. */
  readonly push: (step: WheelStep) => void;
  /** Sends whatever is pending now. Call before sending any other input. */
  readonly flush: () => void;
  /** Drops what is pending and stops the timer. */
  readonly cancel: () => void;
}

export type WheelSchedule = (run: () => void) => () => void;

const frameSchedule: WheelSchedule = (run) => {
  const raf = (
    globalThis as {
      requestAnimationFrame?: (callback: () => void) => number;
      cancelAnimationFrame?: (handle: number) => void;
    }
  ).requestAnimationFrame;
  if (typeof raf === "function") {
    const handle = raf(run);
    return () =>
      (globalThis as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame?.(handle);
  }
  const handle = setTimeout(run, 16);
  return () => clearTimeout(handle);
};

export function createWheelBatcher(
  emit: (step: WheelStep) => void,
  schedule: WheelSchedule = frameSchedule,
): WheelBatcher {
  let pending: WheelStep | null = null;
  let cancelTimer: (() => void) | null = null;

  const flush = () => {
    cancelTimer?.();
    cancelTimer = null;
    const step = pending;
    pending = null;
    if (step !== null) emit(step);
  };

  return {
    push: (step) => {
      pending =
        pending === null
          ? step
          : {
              x: step.x,
              y: step.y,
              deltaX: pending.deltaX + step.deltaX,
              deltaY: pending.deltaY + step.deltaY,
            };
      cancelTimer ??= schedule(flush);
    },
    flush,
    cancel: () => {
      cancelTimer?.();
      cancelTimer = null;
      pending = null;
    },
  };
}
