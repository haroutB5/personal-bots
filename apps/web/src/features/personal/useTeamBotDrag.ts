import type {
  PointerEvent as ReactPointerEvent,
  RefObject,
  MouseEvent as ReactMouseEvent,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { hitTestTeamDropZone, type TeamDiagramPoint, type TeamDropZone } from "./teamDiagramModel";

/** How long a finger has to rest on a bot before it lifts off the diagram. */
export const TEAM_DRAG_LONG_PRESS_MS = 450;
/** Move further than this before the press matures and it was a scroll, not a lift. */
const SCROLL_CANCEL_PX = 10;

export interface TeamDragState {
  readonly botId: string;
  /** How far the node has travelled from where it was picked up, in CSS px. */
  readonly delta: TeamDiagramPoint;
  /** The finger, in the diagram's own coordinates. */
  readonly point: TeamDiagramPoint;
  readonly zone: TeamDropZone | null;
}

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
 * Long-press to lift a bot off the diagram, then drag it onto a team.
 *
 * Scroll versus drag. The diagram is taller than the phone, and a bot node
 * covers a lot of it, so the gesture has to decide early and only once. The
 * node keeps `touch-action: pan-y`, which means a flick scrolls the page
 * normally and the browser never waits on us. A press only becomes a drag if
 * the finger stays within {@link SCROLL_CANCEL_PX} for
 * {@link TEAM_DRAG_LONG_PRESS_MS}; any movement before that cancels the timer,
 * so a scroll can never turn into a drag. Once it does lift, the page must stop
 * scrolling — but `touch-action` is read when the gesture begins, so changing
 * it now would do nothing, and React's own `onTouchMove` is passive. So the
 * lift installs a non-passive `touchmove` listener on the window that calls
 * `preventDefault`, and takes pointer capture so the node keeps receiving moves
 * even when the finger leaves it. Both are undone on drop or cancel.
 */
export function useTeamBotDrag(options: {
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly zones: ReadonlyArray<TeamDropZone>;
  readonly onLift: (botId: string) => void;
  readonly onHover: (botId: string, zone: TeamDropZone | null) => void;
  readonly onDrop: (botId: string, zone: TeamDropZone | null) => void;
  readonly onCancel: (botId: string) => void;
}): {
  readonly drag: TeamDragState | null;
  readonly handlersFor: (botId: string) => TeamDragHandlers;
} {
  const [drag, setDrag] = useState<TeamDragState | null>(null);
  const press = useRef<Press | null>(null);
  // Survives the pointerup that ends a drag, so the click it generates never
  // navigates into the bot the owner was only moving.
  const swallowClick = useRef(false);
  // Kept in a ref so the timer and the window listeners a lift installs read
  // the current callbacks and drop zones rather than the ones from the render
  // the press started on.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  const release = useCallback(() => {
    const current = press.current;
    press.current = null;
    if (current === null) return current;
    if (current.timer !== null) window.clearTimeout(current.timer);
    if (current.lifted) {
      try {
        current.element.releasePointerCapture(current.pointerId);
      } catch {
        // The pointer is already gone; nothing to release.
      }
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("-webkit-user-select");
    }
    setDrag(null);
    return current;
  }, []);

  // A lifted node must not also scroll the page. React's touch handlers are
  // passive, so the block has to be a non-passive window listener.
  useEffect(() => {
    if (drag === null) return;
    const block = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const current = release();
      if (current !== null) latest.current.onCancel(current.botId);
    };
    window.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("touchmove", block);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drag, release]);

  // Leaving the screen mid-drag must not leave the page unscrollable.
  useEffect(() => () => void release(), [release]);

  const pointOf = useCallback((clientX: number, clientY: number): TeamDiagramPoint => {
    const box = latest.current.containerRef.current?.getBoundingClientRect();
    return box === undefined
      ? { x: clientX, y: clientY }
      : { x: clientX - box.left, y: clientY - box.top };
  }, []);

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
    const point = pointOf(current.x, current.y);
    const zone = hitTestTeamDropZone(latest.current.zones, point);
    setDrag({ botId: current.botId, delta: { x: 0, y: 0 }, point, zone });
    latest.current.onLift(current.botId);
    latest.current.onHover(current.botId, zone);
  }, [pointOf]);

  const handlersFor = useCallback(
    (botId: string): TeamDragHandlers => ({
      onPointerDown: (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (press.current !== null) return;
        const element = event.currentTarget;
        press.current = {
          botId,
          pointerId: event.pointerId,
          element,
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
        if (current === null || current.pointerId !== event.pointerId) return;
        current.x = event.clientX;
        current.y = event.clientY;
        const dx = event.clientX - current.startX;
        const dy = event.clientY - current.startY;
        if (!current.lifted) {
          // Still deciding: any real movement means the finger is scrolling.
          if (Math.hypot(dx, dy) > SCROLL_CANCEL_PX) release();
          return;
        }
        const point = pointOf(event.clientX, event.clientY);
        const zone = hitTestTeamDropZone(latest.current.zones, point);
        setDrag((previous) => {
          if (previous !== null && previous.zone?.id !== zone?.id) {
            latest.current.onHover(botId, zone);
          }
          return { botId, delta: { x: dx, y: dy }, point, zone };
        });
      },
      onPointerUp: (event) => {
        const current = press.current;
        if (current === null || current.pointerId !== event.pointerId) return;
        const zone = current.lifted
          ? hitTestTeamDropZone(latest.current.zones, pointOf(event.clientX, event.clientY))
          : null;
        const lifted = current.lifted;
        release();
        if (lifted) latest.current.onDrop(botId, zone);
      },
      onPointerCancel: () => {
        const lifted = press.current?.lifted === true;
        release();
        if (lifted) latest.current.onCancel(botId);
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
    [lift, pointOf, release],
  );

  return { drag, handlersFor };
}
