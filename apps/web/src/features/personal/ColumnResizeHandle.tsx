import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { clampWidth, RESIZE_STEP } from "./desktopColumns";

interface Drag {
  readonly pointerId: number;
  readonly startX: number;
  readonly startWidth: number;
  width: number;
}

/**
 * The draggable inner edge of a desktop column (the bot list, the chat's side
 * panel). A focusable `separator` whose value is the column's width.
 *
 * While it moves it only writes `cssVar` on `target()` and its own
 * `aria-valuenow`: no React state changes until the drag ends, so the chat
 * beside it is not re-rendered per pointer move. `onCommit` then persists the
 * width once, which is also what re-renders the owner with the new value.
 *
 * Keys: arrows move the edge 16px the way they point, Home/End jump to the
 * narrowest/widest, and a double-click restores the default.
 */
export function ColumnResizeHandle({
  label,
  edge,
  controls,
  value,
  min,
  maxWidth,
  defaultWidth,
  cssVar,
  target,
  measure,
  onCommit,
}: {
  readonly label: string;
  /** Which edge of the column the handle sits on (the one facing the chat). */
  readonly edge: "right" | "left";
  /** Id of the column it resizes. */
  readonly controls: string;
  /** The persisted width. */
  readonly value: number;
  readonly min: number;
  /** Widest the column may be right now (depends on the viewport). */
  readonly maxWidth: () => number;
  readonly defaultWidth: number;
  readonly cssVar: string;
  /** Element carrying `cssVar`. */
  readonly target: () => HTMLElement | null;
  /** The column's rendered width, which CSS may have clamped below `value`. */
  readonly measure: () => number | null;
  readonly onCommit: (width: number) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  // Dragging right widens a column whose handle is on its right edge, and
  // narrows one whose handle is on its left.
  const sign = edge === "right" ? 1 : -1;

  const bounds = () => ({ min, max: Math.max(min, maxWidth()) });
  const current = () => {
    const { max } = bounds();
    return clampWidth(measure() ?? value, min, max);
  };
  const show = (width: number) => {
    target()?.style.setProperty(cssVar, `${width}px`);
    ref.current?.setAttribute("aria-valuenow", String(Math.round(width)));
  };
  // The viewport may have changed since render; refresh what a screen reader
  // is about to announce.
  const syncAria = () => {
    ref.current?.setAttribute("aria-valuemax", String(Math.round(bounds().max)));
    ref.current?.setAttribute("aria-valuenow", String(Math.round(current())));
  };
  const commit = (width: number) => {
    const rounded = Math.round(width);
    show(rounded);
    onCommit(rounded);
  };

  const endDrag = () => {
    const active = drag.current;
    if (active === null) return;
    drag.current = null;
    setDragging(false);
    document.documentElement.style.removeProperty("cursor");
    document.documentElement.style.removeProperty("user-select");
    if (Math.round(active.width) !== Math.round(value)) commit(active.width);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = current();
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
    setDragging(true);
    // The whole page shows the resize cursor and selects nothing while the
    // pointer is outside the thin handle mid-drag.
    document.documentElement.style.setProperty("cursor", "col-resize");
    document.documentElement.style.setProperty("user-select", "none");
    syncAria();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active === null || event.pointerId !== active.pointerId) return;
    const { max } = bounds();
    active.width = clampWidth(active.startWidth + sign * (event.clientX - active.startX), min, max);
    show(active.width);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const { max } = bounds();
    const now = current();
    let next: number | null = null;
    if (event.key === "ArrowRight") next = now + sign * RESIZE_STEP;
    else if (event.key === "ArrowLeft") next = now - sign * RESIZE_STEP;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    commit(clampWidth(next, min, max));
  };

  const renderMax = typeof window === "undefined" ? value : Math.max(min, maxWidth());

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={Math.round(renderMax)}
      aria-valuenow={Math.round(clampWidth(value, min, renderMax))}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onFocus={syncAria}
      onDoubleClick={() => commit(clampWidth(defaultWidth, min, bounds().max))}
      className={cn(
        "group absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none select-none",
        // Straddles the bot list's border; the panel's sits just inside its
        // border so it never covers the chat's scrollbar.
        edge === "right" ? "-right-1" : "left-0",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 w-0.5 transition-colors",
          edge === "right" ? "left-1/2 -translate-x-1/2" : "left-0",
          "group-hover:bg-[var(--personal-text-tertiary)]",
          "group-focus-visible:w-[3px] group-focus-visible:bg-[var(--personal-text)]",
          "group-data-[dragging]:bg-[var(--personal-text)]",
        )}
      />
    </div>
  );
}
