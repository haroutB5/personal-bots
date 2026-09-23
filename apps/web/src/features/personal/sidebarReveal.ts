/**
 * Bring the desktop bot list's selected row into view without touching
 * anything outside the list.
 *
 * Not `scrollIntoView`: it also scrolls `overflow: hidden` ancestors, and the
 * shell's root is one (the body never scrolls), so a reveal could nudge the
 * whole layout. This walks the row's own scrollers (the pinned strip
 * horizontally, the list column vertically) and stops at `boundary`.
 */

/** Gap left between a revealed row and the scroller's edge. */
const REVEAL_MARGIN_PX = 12;

/**
 * How far a scroller must move so `[itemStart, itemEnd]` sits inside
 * `[viewStart, viewEnd]`: 0 when it is already fully visible (no nudge for a
 * row the owner can see), otherwise the smallest move that shows it with
 * `margin` to spare. A row taller than the view aligns its start.
 */
export function revealDelta(
  itemStart: number,
  itemEnd: number,
  viewStart: number,
  viewEnd: number,
  margin: number = REVEAL_MARGIN_PX,
): number {
  if (itemStart >= viewStart && itemEnd <= viewEnd) return 0;
  const toStart = itemStart - margin - viewStart;
  if (itemStart < viewStart) return toStart;
  return Math.min(itemEnd + margin - viewEnd, toStart);
}

function scrolls(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll";
}

export function revealInSidebar(element: HTMLElement, boundary: HTMLElement | null): void {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const item = element.getBoundingClientRect();
    const view = node.getBoundingClientRect();
    if (scrolls(style.overflowX) && node.scrollWidth > node.clientWidth) {
      node.scrollLeft += revealDelta(item.left, item.right, view.left, view.right);
    }
    if (scrolls(style.overflowY) && node.scrollHeight > node.clientHeight) {
      node.scrollTop += revealDelta(item.top, item.bottom, view.top, view.bottom);
    }
    if (node === boundary) return;
  }
}
