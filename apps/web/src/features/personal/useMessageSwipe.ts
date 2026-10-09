import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  SWIPE_RELEASE_MS,
  type SwipeSide,
  startsInEdgeZone,
  swipeAxis,
  swipeGoesTheWay,
  swipeOffset,
  swipeTimeOpacity,
} from "./messageSwipe";

/** Set on the swiping element; the time inside reads it, so no render runs per move. */
export const SWIPE_TIME_OPACITY_VAR = "--message-time-opacity";
/** Half the height of the time's two lines: it stays this far inside the message's top and bottom. */
const TIME_HALF_HEIGHT_PX = 15;
const SPRING_BACK = `transform ${SWIPE_RELEASE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;

interface Drag {
  readonly x: number;
  readonly y: number;
  /** null until the move is big enough to tell; "none" is a swipe the wrong way, left alone. */
  axis: "x" | "y" | "none" | null;
  reduceMotion: boolean;
}

export interface MessageSwipe {
  /** Set while the message is being swiped or springing back: where the time sits (px from its top). */
  readonly reveal: { readonly top: number } | null;
  readonly handlers: {
    readonly onPointerDown: (event: ReactPointerEvent) => void;
    readonly onPointerMove: (event: ReactPointerEvent) => void;
    readonly onPointerUp: () => void;
    readonly onPointerCancel: () => void;
  };
  /** True once for the click that ends a swipe, which must not press what is under the finger. */
  readonly consumeClick: () => boolean;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function resetStyle(element: HTMLElement): void {
  element.style.transform = "";
  element.style.transition = "";
  element.style.removeProperty(SWIPE_TIME_OPACITY_VAR);
}

/**
 * The swipe that reveals when a message was sent. The element follows a
 * sideways finger (`align` "end" to the left, "start" to the right) with
 * resistance and springs back on release; the move is written straight to the
 * element's style, and the component only learns when it starts and ends so it
 * can draw the time. A move that is mostly vertical is a scroll and is left to
 * the browser (the element is `touch-action: pan-y`, so it is never cancelled
 * for a sideways one); so is a touch from a mouse, one that starts in the edge
 * swipe back's strip, and any move while `enabled` is false (Select text, an
 * open menu).
 */
export function useMessageSwipe({
  align,
  enabled,
  onSwipeStart,
}: {
  align: SwipeSide;
  enabled: boolean;
  /** The swipe took the touch: stop anything else waiting on it (the long press). */
  onSwipeStart?: (() => void) | undefined;
}): MessageSwipe {
  const [reveal, setReveal] = useState<{ readonly top: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  // The row that has the pointer handlers: the one that moves.
  const target = useRef<HTMLElement | null>(null);
  const swallowClick = useRef(false);
  const springTimer = useRef(0);
  const live = useRef({ enabled, align, onSwipeStart });
  useEffect(() => {
    live.current = { enabled, align, onSwipeStart };
  }, [enabled, align, onSwipeStart]);

  const finishSpring = useCallback(() => {
    if (springTimer.current === 0) return;
    window.clearTimeout(springTimer.current);
    springTimer.current = 0;
    if (target.current !== null) resetStyle(target.current);
    setReveal(null);
  }, []);
  useEffect(
    () => () => {
      finishSpring();
      drag.current = null;
    },
    [finishSpring],
  );

  const settle = useCallback((reduceMotion: boolean) => {
    const element = target.current;
    if (element === null || reduceMotion) {
      if (element !== null) resetStyle(element);
      setReveal(null);
      return;
    }
    element.style.transition = SPRING_BACK;
    element.style.transform = "translate3d(0, 0, 0)";
    element.style.setProperty(SWIPE_TIME_OPACITY_VAR, "0");
    springTimer.current = window.setTimeout(() => {
      springTimer.current = 0;
      resetStyle(element);
      setReveal(null);
    }, SWIPE_RELEASE_MS + 30);
  }, []);

  const end = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.axis === "x") settle(current.reduceMotion);
  }, [settle]);

  const onPointerDown = (event: ReactPointerEvent) => {
    // A new touch ends a spring-back still on its way.
    finishSpring();
    drag.current = null;
    swallowClick.current = false;
    if (!live.current.enabled || event.pointerType === "mouse" || event.isPrimary === false) return;
    // The menu's popup is portaled out of the message, but React bubbles its events up through it.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (startsInEdgeZone(event.clientX)) return;
    target.current = event.currentTarget as HTMLElement;
    drag.current = { x: event.clientX, y: event.clientY, axis: null, reduceMotion: false };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (current === null || current.axis === "y" || current.axis === "none") return;
    if (!live.current.enabled) {
      end();
      return;
    }
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    const element = target.current;
    if (current.axis === null) {
      const axis = swipeAxis(dx, dy);
      if (axis === null) return;
      if (axis === "y" || !swipeGoesTheWay(dx, live.current.align) || element === null) {
        current.axis = axis === "y" ? "y" : "none";
        return;
      }
      current.axis = "x";
      current.reduceMotion = prefersReducedMotion();
      swallowClick.current = true;
      try {
        element.setPointerCapture?.(event.pointerId);
      } catch {
        // The pointer is already gone; the move still ends with the lift.
      }
      live.current.onSwipeStart?.();
      element.style.transition = "none";
      const box = element.getBoundingClientRect();
      const top =
        box.height <= TIME_HALF_HEIGHT_PX * 2
          ? box.height / 2
          : Math.min(
              box.height - TIME_HALF_HEIGHT_PX,
              Math.max(TIME_HALF_HEIGHT_PX, current.y - box.top),
            );
      setReveal({ top });
    }
    if (element === null) return;
    const offset = swipeOffset(dx, live.current.align);
    element.style.transform = `translate3d(${offset}px, 0, 0)`;
    element.style.setProperty(SWIPE_TIME_OPACITY_VAR, String(swipeTimeOpacity(offset)));
  };

  return {
    reveal,
    handlers: { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end },
    consumeClick: () => {
      const swallow = swallowClick.current;
      swallowClick.current = false;
      return swallow;
    },
  };
}
