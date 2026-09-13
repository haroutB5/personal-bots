import type {
  JSX,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useRef, useState } from "react";

/** Width of the revealed Delete action, and how far a swipe must go to keep it open. */
const ACTION_WIDTH = 88;
const AXIS_LOCK_PX = 8;

interface Drag {
  readonly x: number;
  readonly y: number;
  readonly start: number;
  axis: "x" | "y" | null;
}

/**
 * iOS-style swipe action: swipe a row left (or right) to reveal Delete on
 * that side; tap Delete to run `onDelete`, tap the row to close it. Vertical
 * drags scroll the list as usual. The row's own delete stays reachable from
 * the bot editor, so keyboard and screen reader users never need the gesture.
 */
export function SwipeToDelete({
  label,
  onDelete,
  children,
}: {
  label: string;
  /** Resolves once the user confirmed or cancelled; the row closes either way. */
  onDelete: () => Promise<unknown>;
  children: ReactNode;
}): JSX.Element {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  // Set when a gesture moved the row, so the click that ends it never navigates.
  const swallowClick = useRef(false);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, start: offset, axis: null };
    swallowClick.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (current === null) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.axis === null) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (current.axis === "x") {
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }
    }
    if (current.axis !== "x") return;
    swallowClick.current = true;
    const limit = ACTION_WIDTH * 1.25;
    setOffset(Math.max(-limit, Math.min(limit, current.start + dx)));
  };

  const endDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.axis !== "x") return;
    setDragging(false);
    setOffset((value) =>
      value <= -ACTION_WIDTH / 2 ? -ACTION_WIDTH : value >= ACTION_WIDTH / 2 ? ACTION_WIDTH : 0,
    );
  };

  const onClickCapture = (event: ReactMouseEvent) => {
    if (swallowClick.current || offset !== 0) {
      event.preventDefault();
      event.stopPropagation();
      swallowClick.current = false;
      if (!dragging) setOffset(0);
    }
  };

  const runDelete = async () => {
    try {
      await onDelete();
    } finally {
      setOffset(0);
    }
  };

  return (
    <div className="relative overflow-hidden">
      {offset !== 0 ? (
        <button
          type="button"
          onClick={() => void runDelete()}
          aria-label={label}
          className="absolute inset-y-0 flex w-[88px] items-center justify-center bg-[#d93025] text-[15px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
          style={offset < 0 ? { right: 0 } : { left: 0 }}
        >
          Delete
        </button>
      ) : null}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={onClickCapture}
        // A native link drag would cancel the pointer and end the swipe.
        onDragStart={(event) => event.preventDefault()}
        className="relative bg-[var(--personal-bg)] [touch-action:pan-y]"
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 200ms ease",
        }}
      >
        {children}
      </div>
    </div>
  );
}
