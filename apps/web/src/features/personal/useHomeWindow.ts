import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  clampHomeWindow,
  firstHomeWindow,
  HOME_ROW_OVERSCAN,
  HOME_ROW_PITCH,
  homeWindowRange,
  sameHomeWindow,
  type HomeWindowRange,
} from "./homeWindow";
import { perfOptimizationOn } from "./perfFlags";

/**
 * The nearest element the list sits in that scrolls vertically, or null. On
 * the phone that is the column's `<main>`; in the desktop shell, the sidebar's
 * own scroller. Where there is no layout to walk (the test renderer's host
 * instances have no `parentElement`), this answers null and the window stays
 * at its first-paint slice.
 *
 * `getComputedStyle` here forces a style recalculation, so callers find the
 * scroller once and keep it (`useHomeWindow`), never per frame.
 */
export function findScrollParent(start: Element | null): HTMLElement | null {
  if (start === null) return null;
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return null;
  for (let node = start.parentElement ?? null; node !== null; node = node.parentElement ?? null) {
    if (typeof node.getBoundingClientRect !== "function") return null;
    if (/(auto|scroll)/.test(window.getComputedStyle(node).overflowY)) return node as HTMLElement;
  }
  return null;
}

/** The drawn rows' pitch, read off the first two drawn rows. */
function measurePitch(list: Element): number | null {
  const rows = list.querySelectorAll("li > .home-row");
  if (rows.length < 2) return null;
  const pitch = rows[1]!.getBoundingClientRect().top - rows[0]!.getBoundingClientRect().top;
  return pitch > 0 ? pitch : null;
}

export interface HomeWindow {
  /** Goes on the rows' `<ul>`: the hook measures the list and finds its scroller from it. */
  readonly listRef: RefObject<HTMLUListElement | null>;
  /** The slice of the list to draw right now. */
  readonly range: HomeWindowRange;
}

/**
 * Which rows of a fixed-height list to draw, from the scroller the list sits
 * in (homeWindow.ts has the maths and the why). The slice is re-measured on
 * every scroll (at most once per frame), on a window resize, and after a
 * change that moves the geometry: more or fewer rows, the list showing again
 * after Back.
 *
 * Measurement cost is the whole game here: a `getComputedStyle` or a rect read
 * right after React has written the rows forces a synchronous style + layout,
 * and this page is 4,000 px of list. So the scroller is found once and kept,
 * and the per-render check is a no-op while nothing moves - a measured A/B
 * (windowing on against off, 4x CPU) took scroll fps from ~37 to ~25 fps and
 * frame p95 from 36 to 140 ms before these two fixes.
 *
 * `active` is the phone shell's "the list is the thing on screen" flag: while
 * a chat covers the kept list the slice is left exactly as it was, because the
 * geometry (display: none) reads as zero and because the slice from before is
 * the right one for the scroll position the shell restores on Back. The list's
 * own box never changes size, so that restored position lands on the same rows
 * it left.
 */
export function useHomeWindow(
  count: number,
  options: { readonly overscan?: number; readonly active?: boolean } = {},
): HomeWindow {
  const [compact] = useState(() => perfOptimizationOn("home-window-compact"));
  const [deferRestore] = useState(() => perfOptimizationOn("home-scroll-restore"));
  const overscan = options.overscan ?? (compact ? 5 : HOME_ROW_OVERSCAN);
  const active = options.active ?? true;
  // Kill switch "home-window" (perfFlags.ts), read once per load like the
  // other switches: off, every row is drawn and nothing is measured.
  const [enabled] = useState(() => perfOptimizationOn("home-window"));
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [range, setRange] = useState<HomeWindowRange>(() =>
    // Twelve rows cover the phone's first visible band plus the four-row
    // hysteresis cushion. A taller viewport is measured before paint.
    firstHomeWindow(count, compact && options.overscan === undefined ? 4 : overscan),
  );
  const rangeRef = useRef(range);
  const activeRef = useRef(active);
  const measuredCountRef = useRef<number | null>(null);
  const lastAboveRef = useRef<number | null>(null);
  const frameRef = useRef(0);

  const measure = useCallback(
    (allowUrgent = false) => {
      if (!enabled) return;
      const list = listRef.current;
      if (list === null || typeof list.getBoundingClientRect !== "function") return;
      const scroller = scrollerRef.current ?? findScrollParent(list);
      if (scroller === null) return;
      scrollerRef.current = scroller;
      const listRect = list.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      // Not laid out (hidden under an open chat): keep the slice. A zero read
      // here would draw the top of the list over the position Back restores.
      if (listRect.width === 0 || scrollerRect.height === 0) return;
      const hiddenAbove = scrollerRect.top - listRect.top;
      const previousAbove = lastAboveRef.current;
      lastAboveRef.current = hiddenAbove;
      const pitch = measurePitch(list) ?? HOME_ROW_PITCH;
      const viewport = Math.max(0, scroller.clientHeight + Math.min(0, hiddenAbove));
      const previousRange = rangeRef.current;
      const next = homeWindowRange({
        count,
        pitch,
        hiddenAbove,
        // The header and rail take part of the scroller before the list starts.
        // Count only the height available to rows while they are below its top.
        viewport,
        overscan,
        // The slice already drawn: while the visible band stays inside it by
        // the hysteresis margin, the same slice comes back and nothing re-renders.
        previous: rangeRef.current,
        direction:
          previousAbove === null || hiddenAbove === previousAbove
            ? null
            : hiddenAbove > previousAbove
              ? "down"
              : "up",
      });
      if (sameHomeWindow(rangeRef.current, next)) return;
      rangeRef.current = next;
      const above = Math.max(0, hiddenAbove);
      const escaped =
        Math.floor(above / pitch) < previousRange.start ||
        Math.min(count, Math.ceil((above + viewport) / pitch)) > previousRange.end;
      // A jump can outrun overscan. Commit it inside the animation-frame
      // callback, before paint; never flush from the mount/layout effect.
      if (allowUrgent && escaped) flushSync(() => setRange(next));
      else setRange(next);
    },
    [count, enabled, overscan],
  );

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== 0) return;
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
    if (typeof window.cancelAnimationFrame !== "function") return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      measure(true);
    });
  }, [measure]);

  // After a render: clamp a slice the list may have outgrown, and measure only
  // when something the geometry depends on changed - the row count, or the
  // list coming back on screen (Back). Measuring on every render would read
  // the layout right after React's own writes, inside every frame that draws.
  useLayoutEffect(() => {
    const wasActive = activeRef.current;
    activeRef.current = active;
    const clamped = clampHomeWindow(rangeRef.current, count);
    if (!sameHomeWindow(clamped, rangeRef.current)) {
      rangeRef.current = clamped;
      setRange(clamped);
    }
    if (!active) {
      measuredCountRef.current = null;
      if (frameRef.current !== 0) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      return;
    }
    if (!wasActive) {
      // Shown again (Back): the slice from before is still the right one for
      // the scroll position the shell restores in a parent layout effect that
      // runs after this one. Correct in the next frame instead of reading a
      // half-restored scroller.
      measuredCountRef.current = null;
      if (
        deferRestore &&
        frameRef.current === 0 &&
        typeof window !== "undefined" &&
        typeof window.requestAnimationFrame === "function"
      ) {
        // The parent restores scroll in this frame, after our layout effect.
        // Keep the saved slice through that paint and measure the restored
        // geometry in the following frame, rather than the chat's offset.
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = 0;
          if (activeRef.current) scheduleMeasure();
        });
      } else if (!deferRestore) scheduleMeasure();
      return;
    }
    if (measuredCountRef.current === count) return;
    measuredCountRef.current = count;
    measure();
  });

  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const scroller = scrollerRef.current ?? findScrollParent(list);
    if (scroller === null || typeof scroller.addEventListener !== "function") return;
    scrollerRef.current = scroller;
    scroller.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      scroller.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [scheduleMeasure]);

  useEffect(
    () => () => {
      if (
        frameRef.current !== 0 &&
        typeof window !== "undefined" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(frameRef.current);
      }
      frameRef.current = 0;
    },
    [],
  );

  return {
    listRef,
    range: enabled ? clampHomeWindow(range, count) : { start: 0, end: Math.max(0, count) },
  };
}
