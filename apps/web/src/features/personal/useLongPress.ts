import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef } from "react";

/** How long a finger rests before it counts, as iOS uses for its own menus. */
export const LONG_PRESS_MS = 500;
/** Movement that turns a press into a scroll or a swipe instead. */
export const LONG_PRESS_SLOP_PX = 8;
/** How long after the finger lifts the press's closing click can still arrive. */
const CLICK_AFTER_LIFT_MS = 350;

function swallowClick(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Eats the click that ends a long press, wherever it lands, until shortly
 * after the finger lifts. Select mode re-lays the list out under the finger
 * (the New chat and Wrapup buttons go), so that click would otherwise open or
 * toggle whichever row slid under it. The row that was pressed is gone by
 * then, so the lift is watched on the document too. iOS may send no click at
 * all after a hold, which is why the guard ends with the lift.
 */
function swallowClickUntilLift(): void {
  document.addEventListener("click", swallowClick, true);
  const release = () => {
    document.removeEventListener("pointerup", release, true);
    document.removeEventListener("pointercancel", release, true);
    window.setTimeout(
      () => document.removeEventListener("click", swallowClick, true),
      CLICK_AFTER_LIFT_MS,
    );
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
}

export interface LongPressHandlers {
  readonly onPointerDown: (event: ReactPointerEvent) => void;
  readonly onPointerMove: (event: ReactPointerEvent) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onContextMenu: (event: ReactMouseEvent) => void;
}

export interface LongPressOptions {
  /**
   * Called with true when a press starts and false when it ends: cancelled
   * (lifted early, moved, scrolled) or fired. For a visual cue while the
   * finger rests; the hold itself still runs `onLongPress`.
   */
  readonly onPressChange?: ((pressing: boolean) => void) | undefined;
}

/**
 * Press and hold a row: `onLongPress` runs once the finger has rested
 * `LONG_PRESS_MS` without moving `LONG_PRESS_SLOP_PX`, so scrolling and the
 * row's own swipe never trigger it. The click that ends the press is
 * swallowed wherever it lands, and so is the context menu (Android and
 * desktop fire one for a hold). Pair with `select-none` and
 * `-webkit-touch-callout: none` on the row, so iOS offers neither text
 * selection nor a link preview for the same hold.
 */
export function useLongPress(
  onLongPress: () => void,
  enabled = true,
  options?: LongPressOptions,
): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const pressing = useRef(false);
  const callback = useRef(onLongPress);
  const pressChange = useRef(options?.onPressChange);
  useEffect(() => {
    callback.current = onLongPress;
    pressChange.current = options?.onPressChange;
  }, [onLongPress, options?.onPressChange]);

  const setPressing = (next: boolean) => {
    if (pressing.current === next) return;
    pressing.current = next;
    pressChange.current?.(next);
  };
  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  const cancel = () => {
    clearTimer();
    setPressing(false);
  };
  useEffect(() => cancel, []);

  return {
    onPointerDown: (event) => {
      if (!enabled || (event.pointerType === "mouse" && event.button !== 0)) return;
      // A new press restarts the clock without announcing an end first.
      clearTimer();
      start.current = { x: event.clientX, y: event.clientY };
      setPressing(true);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        start.current = null;
        swallowClickUntilLift();
        callback.current();
        setPressing(false);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      const origin = start.current;
      if (origin === null) return;
      if (
        // At or past the swipe row's own axis lock: once it captures the
        // pointer this element stops seeing moves, so cancel no later.
        Math.abs(event.clientX - origin.x) >= LONG_PRESS_SLOP_PX ||
        Math.abs(event.clientY - origin.y) >= LONG_PRESS_SLOP_PX
      ) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (event) => {
      if (enabled) event.preventDefault();
    },
  };
}
