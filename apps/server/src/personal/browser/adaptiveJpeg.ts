// @effect-diagnostics globalTimers:off - a plain timer drives the settle check; it never runs Effect code.
/**
 * Decides when the shared-browser live view is "moving", so the screencast can be rougher
 * and smaller while the page scrolls and sharp once it has stopped.
 *
 * A phone drag arrives as a run of wheel messages, many a second. One or two single notches
 * (a person nudging the page) are not motion and change nothing: motion starts at a wheel
 * that follows another within `enterWithinMs`, and ends `settleMs` after the last one. The
 * controller only tracks that and asks `apply` for a profile in order, one at a time (the
 * browser answers with a stop and a start, and, going back to sharp, one sharp frame of the
 * resting page). Kill switch: `T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=off`.
 */
import type { ScreencastProfile } from "./driver.ts";

export const ADAPTIVE_JPEG_TIMING = {
  /** A wheel this soon after the one before it is motion. */
  enterWithinMs: 120,
  /** Quiet this long after the last wheel: the page has settled. */
  settleMs: 150,
} as const;

export interface MotionControllerOptions {
  /** Asks for a profile; settles when the browser has switched. Never called twice at once. */
  readonly apply: (profile: ScreencastProfile) => Promise<void>;
  /** The profile wanted changed (not yet applied): for the telemetry. */
  readonly onChange?: (profile: ScreencastProfile) => void;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly enterWithinMs?: number;
  readonly settleMs?: number;
}

export interface MotionController {
  /** A wheel step from the person arrived. */
  readonly wheel: () => void;
  /** The screencast was (re)started or stopped: it begins sharp, and nothing is moving. */
  readonly reset: () => void;
  /** The profile the controller wants now. */
  readonly profile: () => ScreencastProfile;
}

export function createMotionController(options: MotionControllerOptions): MotionController {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const enterWithinMs = options.enterWithinMs ?? ADAPTIVE_JPEG_TIMING.enterWithinMs;
  const settleMs = options.settleMs ?? ADAPTIVE_JPEG_TIMING.settleMs;

  let wanted: ScreencastProfile = "sharp";
  let applied: ScreencastProfile = "sharp";
  let pumping = false;
  let lastWheelAt: number | null = null;
  let timer: unknown = null;
  // Bumped by reset(): an apply that finishes after it describes a screencast that is gone.
  let generation = 0;

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (applied !== wanted) {
        const target = wanted;
        const started = generation;
        await options.apply(target).catch(() => undefined);
        // After a reset both sides start over at sharp; do not overwrite that.
        if (started === generation) applied = target;
      }
    } finally {
      pumping = false;
    }
  };

  const want = (profile: ScreencastProfile) => {
    if (wanted === profile) return;
    wanted = profile;
    options.onChange?.(profile);
    void pump();
  };

  const armSettle = (afterMs: number) => {
    timer = setTimer(() => {
      timer = null;
      if (wanted !== "moving" || lastWheelAt === null) return;
      const quietFor = now() - lastWheelAt;
      if (quietFor >= settleMs) want("sharp");
      else armSettle(settleMs - quietFor);
    }, afterMs);
  };

  return {
    wheel: () => {
      const at = now();
      const follows = lastWheelAt !== null && at - lastWheelAt <= enterWithinMs;
      lastWheelAt = at;
      if (wanted === "sharp" && follows) want("moving");
      // One timer, checked against the last wheel when it fires, instead of one per wheel.
      if (wanted === "moving" && timer === null) armSettle(settleMs);
    },
    reset: () => {
      generation += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
      lastWheelAt = null;
      const changed = wanted !== "sharp";
      wanted = "sharp";
      applied = "sharp";
      if (changed) options.onChange?.("sharp");
    },
    profile: () => wanted,
  };
}
