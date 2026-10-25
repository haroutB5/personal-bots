import { useCallback, useEffect, useRef } from "react";

/**
 * Drag-down-to-dismiss for a docked bottom sheet.
 *
 *   <SheetPopup ref={useSheetDragDismiss(onClose)}> ... <div data-sheet-drag-zone> header </div>
 *
 * A touch that starts inside `[data-sheet-drag-zone]` (the grab handle, the header) always
 * drags the sheet. A touch that starts anywhere else drags it only when nothing between the
 * touch and the sheet is scrolled down, so the body still scrolls and a pull from its top
 * dismisses. Taps never move, so buttons and the range switch keep working. Mark an element
 * `[data-sheet-no-drag]` to keep its own gestures (a map, a horizontal scroller).
 *
 * The sheet follows the finger through a transform set on the element: no React state, no
 * re-render per move. Letting go past a quarter of the sheet's height, or in a quick downward
 * flick, hands the sheet to `onDismiss` (the sheet's own close path, so any URL or history
 * entry it owns is dropped the way the x does it) while the sheet slides the rest of the way
 * out; otherwise it springs back. With reduced motion it snaps instead of animating.
 */

/** Past this share of the sheet's height, letting go dismisses it. */
export const DISMISS_FRACTION = 0.25;
/** A downward flick faster than this (px/ms) dismisses it from any distance past `FLICK_MIN_PX`. */
export const FLICK_PX_PER_MS = 0.5;
/** A flick must also have travelled this far, so a twitch cannot close the sheet. */
export const FLICK_MIN_PX = 24;
/** Movement before a touch counts as a drag, a scroll or neither. */
export const DECIDE_PX = 6;
/** Samples older than this do not count towards the release velocity. */
const VELOCITY_WINDOW_MS = 100;
const DISMISS_MS = 200;
const SPRING_MS = 220;
/** Past the exit animation: a close the owner refused springs the sheet back. */
const REFUSED_CHECK_MS = 450;

export const SHEET_DRAG_ZONE_ATTRIBUTE = "data-sheet-drag-zone";
export const SHEET_NO_DRAG_ATTRIBUTE = "data-sheet-no-drag";

export type SheetDragRelease = {
  /** How far the sheet was dragged down, px. */
  readonly offset: number;
  /** The sheet's height, px. */
  readonly height: number;
  /** Downward speed at release, px/ms (negative when moving up). */
  readonly velocity: number;
};

export function shouldDismissSheetDrag({ offset, height, velocity }: SheetDragRelease): boolean {
  if (offset <= 0 || height <= 0) return false;
  if (offset >= height * DISMISS_FRACTION) return true;
  return velocity >= FLICK_PX_PER_MS && offset >= FLICK_MIN_PX;
}

/** Downward speed over the last `VELOCITY_WINDOW_MS` of `samples` (time ms, y px), oldest first. */
export function releaseVelocity(samples: ReadonlyArray<readonly [number, number]>): number {
  const last = samples[samples.length - 1];
  if (last === undefined) return 0;
  let from = last;
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const sample = samples[index];
    if (sample === undefined || last[0] - sample[0] > VELOCITY_WINDOW_MS) break;
    from = sample;
  }
  const elapsed = last[0] - from[0];
  return elapsed > 0 ? (last[1] - from[1]) / elapsed : 0;
}

/** The slice of an element `sheetDragMayStart` reads (a real Element satisfies it). */
export interface SheetDragNode {
  readonly parentElement: SheetDragNode | null;
  readonly scrollTop: number;
  closest(selector: string): SheetDragNode | null;
}
export interface SheetDragRoot extends SheetDragNode {
  contains(other: unknown): boolean;
}

function isSheetDragNode(value: unknown): value is SheetDragNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { closest?: unknown }).closest === "function"
  );
}

/**
 * Whether a touch starting at `target` may drag `sheet`: always from a drag zone, never from a
 * no-drag element, and from anywhere else only while no ancestor up to the sheet is scrolled.
 */
export function sheetDragMayStart(target: unknown, sheet: SheetDragRoot): boolean {
  if (!isSheetDragNode(target) || !sheet.contains(target)) return false;
  if (target.closest(`[${SHEET_NO_DRAG_ATTRIBUTE}]`) !== null) return false;
  const zone = target.closest(`[${SHEET_DRAG_ZONE_ATTRIBUTE}]`);
  if (zone !== null && sheet.contains(zone)) return true;
  for (let node: SheetDragNode | null = target; node !== null; node = node.parentElement) {
    if (node.scrollTop > 0) return false;
    if (node === sheet) break;
  }
  return true;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type Phase = "idle" | "pending" | "dragging" | "ignored";

/** Returns the ref to put on the sheet's popup. `onDismiss` is called at most once per gesture. */
export function useSheetDragDismiss(onDismiss: () => void): (node: HTMLElement | null) => void {
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  return useCallback((sheet: HTMLElement | null) => {
    if (sheet === null) return undefined;

    let phase: Phase = "idle";
    let startX = 0;
    let startY = 0;
    let originY = 0;
    let offset = 0;
    let height = 0;
    let samples: Array<readonly [number, number]> = [];
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const setOffset = (next: number) => {
      offset = next;
      sheet.style.transform = next === 0 ? "" : `translateY(${next}px)`;
    };
    const springBack = () => {
      clearTimer();
      if (offset === 0 || prefersReducedMotion()) {
        sheet.style.transition = "";
        setOffset(0);
        return;
      }
      sheet.style.transition = `transform ${SPRING_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1)`;
      sheet.style.transform = "translateY(0px)";
      offset = 0;
      timer = setTimeout(() => {
        sheet.style.transition = "";
        sheet.style.transform = "";
      }, SPRING_MS + 30);
    };
    const dismiss = () => {
      clearTimer();
      const reduced = prefersReducedMotion();
      sheet.style.transition = reduced ? "none" : `transform ${DISMISS_MS}ms ease-out`;
      sheet.style.transform = `translateY(${Math.max(height, offset)}px)`;
      dismissRef.current();
      // The owner may keep the sheet open (a guard, an unsaved change): do not strand it off screen.
      timer = setTimeout(() => {
        if (sheet.isConnected && sheet.hasAttribute("data-open")) springBack();
      }, REFUSED_CHECK_MS);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (phase === "dragging") springBack();
      phase = "idle";
      if (event.touches.length !== 1) {
        phase = "ignored";
        return;
      }
      const touch = event.touches[0];
      if (touch === undefined || !sheetDragMayStart(event.target, sheet)) {
        phase = "ignored";
        return;
      }
      clearTimer();
      // A spring-back still running is cut short so the new drag starts from the resting place.
      sheet.style.transition = "";
      sheet.style.transform = "";
      offset = 0;
      startX = touch.clientX;
      startY = touch.clientY;
      height = sheet.getBoundingClientRect().height;
      samples = [[event.timeStamp, touch.clientY]];
      phase = "pending";
    };

    const onTouchMove = (event: TouchEvent) => {
      if (phase === "ignored" || phase === "idle") return;
      if (event.touches.length !== 1) {
        if (phase === "dragging") springBack();
        phase = "ignored";
        return;
      }
      const touch = event.touches[0];
      if (touch === undefined) return;
      const dy = touch.clientY - startY;
      if (phase === "pending") {
        const dx = touch.clientX - startX;
        if (Math.abs(dy) < DECIDE_PX && Math.abs(dx) < DECIDE_PX) return;
        // Up, or more across than down: a scroll or a swipe that belongs to the content.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          phase = "ignored";
          return;
        }
        phase = "dragging";
        originY = touch.clientY;
        sheet.style.transition = "none";
      }
      if (event.cancelable) event.preventDefault();
      samples.push([event.timeStamp, touch.clientY]);
      if (samples.length > 8) samples = samples.slice(-8);
      setOffset(Math.max(0, touch.clientY - originY));
    };

    const onTouchEnd = () => {
      if (phase !== "dragging") {
        phase = "idle";
        return;
      }
      phase = "idle";
      if (shouldDismissSheetDrag({ offset, height, velocity: releaseVelocity(samples) })) {
        dismiss();
      } else {
        springBack();
      }
    };

    const onTouchCancel = () => {
      if (phase === "dragging") springBack();
      phase = "idle";
    };

    // touchmove is not passive here: once a drag is under way the page must not scroll with it.
    sheet.style.transform = "";
    sheet.style.transition = "";
    sheet.addEventListener("touchstart", onTouchStart, { passive: true });
    sheet.addEventListener("touchmove", onTouchMove, { passive: false });
    sheet.addEventListener("touchend", onTouchEnd, { passive: true });
    sheet.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      clearTimer();
      sheet.removeEventListener("touchstart", onTouchStart);
      sheet.removeEventListener("touchmove", onTouchMove);
      sheet.removeEventListener("touchend", onTouchEnd);
      sheet.removeEventListener("touchcancel", onTouchCancel);
    };
  }, []);
}
