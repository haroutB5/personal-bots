import { useCallback, useEffect, useRef } from "react";

/** How long after the finger lifts its own release can still read as a dismissal. */
export const CLOSE_GUARD_AFTER_LIFT_MS = 350;

/** Closes the owner asked for: these always go through, guard or not. */
const DELIBERATE_CLOSE = new Set(["item-press", "escape-key", "close-press", "imperative-action"]);

/**
 * Whether a menu that a long press opened may close now. Until the pressing
 * finger has lifted, and for a moment after, a close request is the press's
 * own release (Base UI reads the lift as a press outside the popup, which
 * just opened under the finger), not the owner dismissing it.
 */
export function mayClosePressOpenedMenu(
  reason: string | undefined,
  guardUntilMs: number,
  nowMs: number,
): boolean {
  if (reason !== undefined && DELIBERATE_CLOSE.has(reason)) return true;
  return nowMs >= guardUntilMs;
}

/**
 * For a menu opened by a long press: call `armUntilLift` as the menu opens,
 * and gate `onOpenChange(false)` through `mayClose`. A stationary hold then
 * leaves the menu open after release, and the next tap picks an action.
 */
export function usePressOpenedMenuGuard(): {
  readonly armUntilLift: () => void;
  readonly mayClose: (reason: string | undefined) => boolean;
} {
  const guardUntil = useRef(0);
  const detach = useRef<(() => void) | null>(null);

  const armUntilLift = useCallback(() => {
    detach.current?.();
    guardUntil.current = Number.POSITIVE_INFINITY;
    // On the document: the popup opens under the finger, so the lift may land
    // on it (or its backdrop) rather than on the element that was pressed.
    const release = () => {
      guardUntil.current = performance.now() + CLOSE_GUARD_AFTER_LIFT_MS;
      detach.current?.();
    };
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    detach.current = () => {
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
      detach.current = null;
    };
  }, []);
  useEffect(() => () => detach.current?.(), []);

  const mayClose = useCallback(
    (reason: string | undefined) =>
      mayClosePressOpenedMenu(reason, guardUntil.current, performance.now()),
    [],
  );
  return { armUntilLift, mayClose };
}
