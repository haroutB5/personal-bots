// @effect-diagnostics globalTimers:off - a plain timer drives the settle check; it never runs Effect code.
/**
 * Decides when the shared-browser live view is "moving", so the screencast can be rougher
 * and smaller while the page scrolls and sharp once it has stopped.
 *
 * A phone drag arrives as a run of wheel messages, many a second. One or two single notches
 * (a person nudging the page) are not motion and change nothing: motion starts at a wheel
 * that follows another within `enterWithinMs`, and ends `settleMs` after the last one. The
 * controller only tracks that and tells `apply` each change of profile at the moment it happens
 * (the browser answers with a stop and a start, and, going back to sharp, one sharp frame of the
 * resting page). It does not wait for one switch before announcing the next: the browser keeps
 * them in order itself, and a scroll that resumes while the sharp frame is still being taken must
 * reach it at once so it can drop that frame. Kill switch: `T3CODE_PERSONAL_BROWSER_ADAPTIVE_JPEG=off`.
 */
import type { ScreencastProfile } from "./driver.ts";

export const ADAPTIVE_JPEG_TIMING = {
  /** A wheel this soon after the one before it is motion. */
  enterWithinMs: 120,
  /** Quiet this long after the last wheel: the page has settled. */
  settleMs: 150,
  /**
   * After the finger lifted (`end`): this long after the last wheel step, so the page has applied
   * it before the sharp picture is taken. Shorter than `settleMs` because nothing more is coming.
   */
  endGuardMs: 40,
} as const;

export interface MotionControllerOptions {
  /**
   * Asks for a profile; settles when the browser has switched. Called at every change, in order,
   * without waiting for the one before: the browser applies them one at a time.
   */
  readonly apply: (profile: ScreencastProfile) => Promise<void>;
  /** The profile wanted changed (not yet applied): for the telemetry. */
  readonly onChange?: (profile: ScreencastProfile) => void;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly enterWithinMs?: number;
  readonly settleMs?: number;
  readonly endGuardMs?: number;
}

export interface MotionController {
  /** A wheel step from the person arrived. */
  readonly wheel: () => void;
  /**
   * The finger that was scrolling lifted: no more steps follow from it. The picture goes sharp
   * after a short guard instead of the full quiet time. Steps that do arrive meanwhile (a new
   * gesture) keep it rough as usual.
   */
  readonly end: () => void;
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
  const endGuardMs = options.endGuardMs ?? ADAPTIVE_JPEG_TIMING.endGuardMs;

  let wanted: ScreencastProfile = "sharp";
  let lastWheelAt: number | null = null;
  // When the finger last lifted; counts only while no step has come after it.
  let endedAt: number | null = null;
  let timer: unknown = null;

  const want = (profile: ScreencastProfile) => {
    if (wanted === profile) return;
    wanted = profile;
    options.onChange?.(profile);
    // A switch that fails leaves the screencast as it was; the next change asks again.
    void Promise.resolve(options.apply(profile)).catch(() => undefined);
  };

  /** How long the page must have been quiet: short once the finger is known to have lifted. */
  const quietNeeded = () =>
    endedAt !== null && lastWheelAt !== null && endedAt >= lastWheelAt ? endGuardMs : settleMs;

  const armSettle = (afterMs: number) => {
    timer = setTimer(() => {
      timer = null;
      if (wanted !== "moving" || lastWheelAt === null) return;
      const quietFor = now() - lastWheelAt;
      const needed = quietNeeded();
      if (quietFor >= needed) want("sharp");
      else armSettle(needed - quietFor);
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
    end: () => {
      // Nothing is moving, or it is a single notch that never counted as motion: nothing to end.
      if (wanted !== "moving" || lastWheelAt === null) return;
      endedAt = now();
      if (timer !== null) clearTimer(timer);
      armSettle(Math.max(0, endGuardMs - (endedAt - lastWheelAt)));
    },
    reset: () => {
      if (timer !== null) clearTimer(timer);
      timer = null;
      lastWheelAt = null;
      endedAt = null;
      const changed = wanted !== "sharp";
      wanted = "sharp";
      if (changed) options.onChange?.("sharp");
    },
    profile: () => wanted,
  };
}
