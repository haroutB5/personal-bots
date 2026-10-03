/**
 * Sums the scroll steps a finger makes between two frames into one `Wheel`
 * message. A touch drag reports 60 to 120 moves a second and the laptop pays
 * a round trip to Chrome for each, so the phone sends at most one per animation
 * frame: the deltas added up, the latest point kept. Anything else the phone
 * sends goes out after the pending scroll (see `flush`), so order is kept.
 *
 * Kill switch: `bots:perf-off = wheel-batch` sends every step as it happens.
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

type Schedule = (run: () => void) => () => void;

const frameSchedule: Schedule = (run) => {
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
  schedule: Schedule = frameSchedule,
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
