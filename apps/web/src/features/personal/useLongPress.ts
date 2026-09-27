import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef } from "react";

/** How long a finger rests before it counts, as iOS uses for its own menus. */
export const LONG_PRESS_MS = 500;
/** Movement that turns a press into a scroll or a swipe instead. */
export const LONG_PRESS_SLOP_PX = 8;

export interface LongPressHandlers {
  readonly onPointerDown: (event: ReactPointerEvent) => void;
  readonly onPointerMove: (event: ReactPointerEvent) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onContextMenu: (event: ReactMouseEvent) => void;
  readonly onClickCapture: (event: ReactMouseEvent) => void;
}

/**
 * Press and hold a row: `onLongPress` runs once the finger has rested
 * `LONG_PRESS_MS` without moving `LONG_PRESS_SLOP_PX`, so scrolling and the
 * row's own swipe never trigger it. The click that ends the press is
 * swallowed (the row must not also open), and so is the context menu (Android
 * and desktop fire one for a hold). Pair with `select-none` and
 * `-webkit-touch-callout: none` on the row, so iOS offers neither text
 * selection nor a link preview for the same hold.
 */
export function useLongPress(onLongPress: () => void, enabled = true): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  useEffect(() => {
    callback.current = onLongPress;
  }, [onLongPress]);

  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);

  return {
    onPointerDown: (event) => {
      fired.current = false;
      if (!enabled || (event.pointerType === "mouse" && event.button !== 0)) return;
      cancel();
      start.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        start.current = null;
        fired.current = true;
        callback.current();
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
    onClickCapture: (event) => {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
