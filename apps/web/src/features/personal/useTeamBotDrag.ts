import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

/** How long a finger has to rest on a bot before it lifts off its card. */
export const TEAM_DRAG_LONG_PRESS_MS = 450;
/** Move further than this before the press matures and it was a scroll, not a lift. */
const SCROLL_CANCEL_PX = 10;

/**
 * What React sees of a drag: which bot, and which drop card is under the
 * finger. The finger's position is deliberately not here; it changes on every
 * frame and moves the token straight in the DOM (see {@link useTeamBotDrag}).
 */
export interface TeamDragState {
  readonly botId: string;
  /** The drop card under the finger, or null. */
  readonly zoneId: string | null;
}

/** Where the token rides against the finger, so the finger never hides the card it is over. */
const TOKEN_OFFSET = { x: -40, y: -52 } as const;

export interface TeamDragHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  readonly onDragStart: (event: { preventDefault: () => void }) => void;
  readonly onContextMenu: (event: { preventDefault: () => void }) => void;
}

interface Press {
  readonly botId: string;
  readonly pointerId: number;
  readonly element: HTMLElement;
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
  timer: number | null;
  lifted: boolean;
}

/**
 * Long-press to lift a bot off its card, then drag it over a drop card.
 *
 * Scroll versus drag. The screen is taller than the phone, and a node covers a
 * lot of it, so the gesture decides early and only once. The node keeps
 * `touch-action: pan-y`, so a flick scrolls the page and the browser never
 * waits on us. A press only becomes a drag if the finger stays within
 * {@link SCROLL_CANCEL_PX} for {@link TEAM_DRAG_LONG_PRESS_MS}; any movement
 * before that cancels the timer, so a scroll can never turn into a drag. Once
 * it lifts the page has to stop scrolling, but `touch-action` is read when the
 * gesture begins and React's touch handlers are passive, so the lift installs a
 * non-passive `touchmove` listener on the window that calls `preventDefault`.
 *
 * The lift also brings up the zoomed-out drop cards, and a lifted drag is
 * followed on the window (pointermove, pointerup, pointercancel) rather than on
 * the node, so it does not matter what re-renders under the finger. Every
 * listener and the page's text-selection lock are undone on drop, cancel,
 * Escape or leaving the screen.
 *
 * Nothing renders per pointer move. A move only records the finger's position;
 * one requestAnimationFrame per frame writes the token's `transform` straight
 * to the DOM (no layout, no React) and looks up the drop card under the finger.
 * React is told only when that card changes, a handful of times per drag, so
 * the screen underneath is not rendered again while the finger travels.
 */
export function useTeamBotDrag(options: {
  /** Which drop card is under a viewport point (the cards are read from the DOM). */
  readonly zoneAt: (x: number, y: number) => string | null;
  readonly onLift: (botId: string) => void;
  readonly onHover: (botId: string, zoneId: string | null) => void;
  /** Let go over a card, or over nothing (null), which keeps the cards open to tap. */
  readonly onDrop: (botId: string, zoneId: string | null) => void;
  readonly onCancel: (botId: string) => void;
}): {
  readonly drag: TeamDragState | null;
  /** Attach to the lifted bot's token: the hook moves it with `transform` only. */
  readonly tokenRef: (element: HTMLElement | null) => void;
  readonly handlersFor: (botId: string) => TeamDragHandlers;
  /** Ends a drag without dropping (the cards were closed some other way). */
  readonly cancel: () => void;
} {
  const [drag, setDrag] = useState<TeamDragState | null>(null);
  const press = useRef<Press | null>(null);
  // Survives the pointerup that ends a drag, so the click it generates never
  // navigates into the bot the owner was only moving.
  const swallowClick = useRef(false);
  // Kept in a ref so the timer and the window listeners a lift installs read
  // the current callbacks rather than the ones from the render the press began on.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const windowListeners = useRef<(() => void) | null>(null);
  const token = useRef<HTMLElement | null>(null);
  const frame = useRef<number | null>(null);
  const lastZone = useRef<string | null>(null);

  const paintToken = useCallback(() => {
    const active = press.current;
    const element = token.current;
    if (active === null || element === null) return;
    element.style.transform = `translate3d(${String(active.x + TOKEN_OFFSET.x)}px, ${String(active.y + TOKEN_OFFSET.y)}px, 0) translate(-50%, -50%) rotate(-4deg)`;
  }, []);
  const tokenRef = useCallback(
    (element: HTMLElement | null) => {
      token.current = element;
      // The token mounts a render after the lift: put it under the finger at once.
      if (element !== null) paintToken();
    },
    [paintToken],
  );

  const release = useCallback(() => {
    const current = press.current;
    press.current = null;
    windowListeners.current?.();
    windowListeners.current = null;
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    if (current === null) return current;
    if (current.timer !== null) window.clearTimeout(current.timer);
    if (current.lifted) {
      try {
        current.element.releasePointerCapture(current.pointerId);
      } catch {
        // The node is gone or the pointer is; nothing to release.
      }
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("-webkit-user-select");
    }
    setDrag(null);
    return current;
  }, []);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const current = release();
      if (current !== null) latest.current.onCancel(current.botId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dragging, release]);

  // Leaving the screen mid-drag must not leave the page unscrollable.
  useEffect(() => () => void release(), [release]);

  const lift = useCallback(() => {
    const current = press.current;
    if (current === null || current.lifted) return;
    current.lifted = true;
    current.timer = null;
    swallowClick.current = true;
    try {
      current.element.setPointerCapture(current.pointerId);
    } catch {
      // Mouse pointers that already left the element; the drag still works.
    }
    document.body.style.setProperty("user-select", "none");
    document.body.style.setProperty("-webkit-user-select", "none");
    navigator.vibrate?.(8);

    // A lifted bot must not also scroll the page. React's touch handlers are
    // passive, so the block is a non-passive window listener, installed here so
    // it is in place before the finger's first move after the lift.
    const block = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    const tick = () => {
      frame.current = null;
      const active = press.current;
      if (active === null || !active.lifted) return;
      paintToken();
      const zoneId = latest.current.zoneAt(active.x, active.y);
      if (zoneId === lastZone.current) return;
      lastZone.current = zoneId;
      latest.current.onHover(active.botId, zoneId);
      setDrag((previous) =>
        previous === null || previous.zoneId === zoneId ? previous : { ...previous, zoneId },
      );
    };
    const follow = (event: PointerEvent) => {
      const active = press.current;
      if (active === null || active.pointerId !== event.pointerId || !active.lifted) return;
      active.x = event.clientX;
      active.y = event.clientY;
      frame.current ??= window.requestAnimationFrame(tick);
    };
    const finish = (event: PointerEvent) => {
      const active = press.current;
      if (active === null || active.pointerId !== event.pointerId) return;
      const zoneId = latest.current.zoneAt(event.clientX, event.clientY);
      release();
      latest.current.onDrop(active.botId, zoneId);
    };
    const abort = (event: PointerEvent) => {
      const active = press.current;
      if (active === null || active.pointerId !== event.pointerId) return;
      release();
      latest.current.onCancel(active.botId);
    };
    window.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("pointermove", follow);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", abort);
    windowListeners.current = () => {
      window.removeEventListener("touchmove", block);
      window.removeEventListener("pointermove", follow);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", abort);
    };

    // The cards mount on the next render, so nothing is under the finger yet.
    lastZone.current = null;
    setDrag({ botId: current.botId, zoneId: null });
    latest.current.onLift(current.botId);
  }, [paintToken, release]);

  const handlersFor = useCallback(
    (botId: string): TeamDragHandlers => ({
      onPointerDown: (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (press.current !== null) return;
        press.current = {
          botId,
          pointerId: event.pointerId,
          element: event.currentTarget,
          startX: event.clientX,
          startY: event.clientY,
          x: event.clientX,
          y: event.clientY,
          timer: window.setTimeout(lift, TEAM_DRAG_LONG_PRESS_MS),
          lifted: false,
        };
        swallowClick.current = false;
      },
      onPointerMove: (event) => {
        const current = press.current;
        if (current === null || current.pointerId !== event.pointerId || current.lifted) return;
        current.x = event.clientX;
        current.y = event.clientY;
        // Still deciding: any real movement means the finger is scrolling.
        const moved = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
        if (moved > SCROLL_CANCEL_PX) release();
      },
      // A press that never lifted just ends; a lifted one is finished on the window.
      onPointerUp: (event) => {
        const current = press.current;
        if (current === null || current.pointerId !== event.pointerId || current.lifted) return;
        release();
      },
      onPointerCancel: (event) => {
        const current = press.current;
        if (current === null || current.pointerId !== event.pointerId || current.lifted) return;
        release();
      },
      // The tap that ends a drag must not also open the bot. A plain tap never
      // lifts, so `swallowClick` stays false and the link behaves as before.
      onClickCapture: (event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onDragStart: (event) => event.preventDefault(),
      // iOS raises its callout on the same long press that lifts the node.
      onContextMenu: (event) => event.preventDefault(),
    }),
    [lift, release],
  );

  const cancel = useCallback(() => void release(), [release]);

  return { drag, tokenRef, handlersFor, cancel };
}
