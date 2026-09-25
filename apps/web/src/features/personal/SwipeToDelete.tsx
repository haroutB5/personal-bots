import type {
  JSX,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { useEffect, useRef, useState } from "react";

/** Width of one revealed action, and half of it is how far a swipe must go to keep it open. */
const ACTION_WIDTH = 88;
const AXIS_LOCK_PX = 8;

interface Drag {
  readonly x: number;
  readonly y: number;
  readonly start: number;
  axis: "x" | "y" | null;
}

/** An action revealed by swiping the other way, e.g. pin/unpin or mute. */
export interface SwipeSecondaryAction {
  readonly label: string;
  /** What the revealed button says. */
  readonly text: string;
  readonly run: () => Promise<unknown> | unknown;
  /** Button fill; the first action uses the primary fill, later ones a quieter one. */
  readonly tone?: "primary" | "quiet" | undefined;
}

const NO_SECONDARY_ACTIONS: ReadonlyArray<SwipeSecondaryAction> = [];

/** Where a released swipe rests: fully open on the side it went past halfway, else closed. */
export function settleSwipeOffset(value: number, leftWidth: number, rightWidth: number): number {
  if (value <= -ACTION_WIDTH / 2) return -leftWidth;
  if (value >= ACTION_WIDTH / 2) return rightWidth;
  return 0;
}

// Only one row in the app is open at a time: opening another closes this one.
let closeOpenRow: (() => void) | null = null;

function claimOpenRow(close: () => void): void {
  if (closeOpenRow !== null && closeOpenRow !== close) closeOpenRow();
  closeOpenRow = close;
}

function releaseOpenRow(close: () => void): void {
  if (closeOpenRow === close) closeOpenRow = null;
}

function swallowClickOnce(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * iOS-style swipe action: swipe a row left to reveal Delete (after any
 * `trailingActions`, e.g. Archive, as in Mail); tap one to run it, tap the row
 * to close it. With `secondaryActions`, swiping the other way reveals those
 * (side by side, like Pin and Mute in Messages) instead of a second Delete.
 * Vertical drags scroll the list as usual. One row is open at a time, and a
 * tap elsewhere (which does nothing else) or a scroll closes it. Every action stays reachable without
 * the gesture elsewhere on the screen, so keyboard and screen reader users
 * never need it.
 */
export function SwipeToDelete({
  label,
  onDelete,
  secondaryActions = NO_SECONDARY_ACTIONS,
  trailingActions = NO_SECONDARY_ACTIONS,
  children,
}: {
  label: string;
  /** Resolves once the user confirmed or cancelled; the row closes either way. */
  onDelete: () => Promise<unknown>;
  secondaryActions?: ReadonlyArray<SwipeSecondaryAction> | undefined;
  /** Shown left of Delete when swiping left, in the quiet fill. */
  trailingActions?: ReadonlyArray<SwipeSecondaryAction> | undefined;
  children: ReactNode;
}): JSX.Element {
  // Swiping right opens as wide as its buttons; left is Delete plus any trailing actions.
  const secondaryWidth = ACTION_WIDTH * secondaryActions.length;
  const leftWidth = ACTION_WIDTH * (1 + trailingActions.length);
  const rightWidth = secondaryWidth > 0 ? secondaryWidth : ACTION_WIDTH;
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  // Set when a gesture moved the row, so the click that ends it never navigates.
  const swallowClick = useRef(false);
  // Stable identity for the open-row registry.
  const [close] = useState(() => () => setOffset(0));

  const open = offset !== 0 && !dragging;
  useEffect(() => {
    if (!open) return;
    claimOpenRow(close);
    const onOutsidePointer = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node | null)) return;
      close();
      // As in Messages, that tap only closes the row: the click it ends must
      // not also press whatever it landed on (Wrapup, another row, a tab).
      document.addEventListener("click", swallowClickOnce, { capture: true, once: true });
      setTimeout(() => document.removeEventListener("click", swallowClickOnce, true), 600);
    };
    document.addEventListener("pointerdown", onOutsidePointer, true);
    // Scroll does not bubble; capture sees the list's scroller and the window.
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onOutsidePointer, true);
      document.removeEventListener("scroll", close, true);
      releaseOpenRow(close);
    };
  }, [open, close]);
  useEffect(() => () => releaseOpenRow(close), [close]);

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
    setOffset(Math.max(-leftWidth * 1.25, Math.min(rightWidth * 1.25, current.start + dx)));
  };

  const endDrag = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.axis !== "x") return;
    setDragging(false);
    setOffset((value) => settleSwipeOffset(value, leftWidth, rightWidth));
  };

  const onClickCapture = (event: ReactMouseEvent) => {
    if (swallowClick.current || offset !== 0) {
      event.preventDefault();
      event.stopPropagation();
      swallowClick.current = false;
      if (!dragging) setOffset(0);
    }
  };

  // Closes first: a confirm dialog the action opens is outside the row, and a
  // tap on it must not count as the tap that closes an open row.
  const run = async (action: () => Promise<unknown> | unknown) => {
    setOffset(0);
    await action();
  };

  // Swiping right reveals the secondary actions when there are any; swiping
  // left is always Delete, so the destructive side never moves.
  const showSecondary = offset > 0 && secondaryActions.length > 0;
  const showTrailing = offset < 0 && trailingActions.length > 0;

  return (
    <div ref={root} className="relative overflow-hidden">
      {showSecondary ? (
        <div className="absolute inset-y-0 left-0 flex" data-swipe-actions="">
          {secondaryActions.map((action, index) => (
            <button
              key={action.text}
              type="button"
              onClick={() => void run(action.run)}
              aria-label={action.label}
              className={`flex h-full w-[88px] items-center justify-center text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-primary-text)] ${(action.tone ?? (index === 0 ? "primary" : "quiet")) === "primary" ? "bg-[var(--personal-primary)]" : "bg-[var(--personal-text-secondary)]"}`}
            >
              {action.text}
            </button>
          ))}
        </div>
      ) : offset !== 0 ? (
        <div
          className="absolute inset-y-0 flex"
          data-swipe-actions=""
          style={offset < 0 ? { right: 0 } : { left: 0 }}
        >
          {showTrailing
            ? trailingActions.map((action) => (
                <button
                  key={action.text}
                  type="button"
                  onClick={() => void run(action.run)}
                  aria-label={action.label}
                  className="flex h-full w-[88px] items-center justify-center bg-[var(--personal-text-secondary)] text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-primary-text)]"
                >
                  {action.text}
                </button>
              ))
            : null}
          <button
            type="button"
            onClick={() => void run(onDelete)}
            aria-label={label}
            className="flex h-full w-[88px] items-center justify-center bg-[var(--personal-destructive)] text-[15px] font-semibold text-[var(--personal-destructive-text)] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-destructive-text)]"
          >
            Delete
          </button>
        </div>
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
