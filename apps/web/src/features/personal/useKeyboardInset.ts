import type { RefObject } from "react";
import { useEffect, useState } from "react";

/** Input types the on-screen keyboard never opens for. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * Whether this node is something the on-screen keyboard opens for.
 *
 * Deliberately duck-typed rather than `instanceof`: the only properties read
 * are ones every relevant element has, and the hook is exercised against
 * lightweight stand-ins.
 */
function keyboardTarget(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const element = node as {
    tagName?: unknown;
    type?: unknown;
    readOnly?: unknown;
    isContentEditable?: unknown;
  };
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (element.readOnly === true) return false;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = typeof element.type === "string" ? element.type.toLowerCase() : "text";
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return element.isContentEditable === true;
}

/**
 * A hidden, zero-size box pinned to the bottom of the fixed-position
 * containing block: its rect says where a fixed bottom sheet actually ends.
 * Null where the document cannot host one (then innerHeight stands in).
 */
function createFixedEdgeProbe(): HTMLElement | null {
  try {
    const body = document.body;
    if (!body || typeof document.createElement !== "function") return null;
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none";
    body.append(probe);
    return probe;
  } catch {
    return null;
  }
}

/**
 * How far the conversation shell's bottom edge sits below the visible
 * viewport's bottom edge - i.e. the padding needed to lift the composer
 * above the on-screen keyboard.
 *
 * Measured on a real iPhone (standalone PWA): the keyboard shrinks the
 * LAYOUT viewport (innerHeight 873 -> 487) while `100dvh` does not follow,
 * so the shell keeps its full height and the composer lands below the fold
 * with `innerHeight - visualViewport.height` reading 0. No single global
 * height is trustworthy, so the overlap is computed geometrically:
 *
 *   covered = shellRect.bottom - (visualViewport.offsetTop + height)
 *
 * (client coords share the layout-viewport origin with offsetTop). This is
 * exact for all three observed keyboard models: iOS resizing the layout
 * viewport, older iOS shrinking only the visual viewport (with or without a
 * pan), and Chromium's resizes-content where the shell itself shrinks and
 * the overlap is 0.
 *
 * Geometry alone is not enough to know the keyboard went back DOWN. iOS
 * coalesces `visualViewport` events during the dismiss animation, and the last
 * one delivered can carry a height from the middle of that animation - after
 * which nothing else fires and the inset latches at a part-way value, leaving
 * the composer stranded mid-screen with dead space under it. Two independent
 * signals close that hole, neither of them a timer:
 *
 *  - Focus. The keyboard can only cover the composer while something typable
 *    is focused, and iOS blurs the field on every way down (Done, swipe-down,
 *    tapping elsewhere). Nothing typable focused therefore means inset 0,
 *    whatever the last geometry event claimed.
 *  - `window.resize`. The layout viewport growing back fires this even when
 *    the `visualViewport` resize for the same step was swallowed.
 *
 * Leftover document pan is reset only when the shell is fully visible again
 * (overlap <= 1); resetting while typing drags the composer back under the
 * keyboard.
 *
 * Without a shell (a fixed bottom sheet such as Rename chat), the edge that
 * matters is the one `position: fixed; bottom: 0` lands on, read from a
 * zero-size probe. `innerHeight` is the wrong edge on that iPhone: it follows
 * the keyboard while fixed boxes do not, so the overlap read 0 and the sheet,
 * text field and all, sat behind the keyboard (26 Sep).
 */
export function useKeyboardInset(shellRef?: RefObject<HTMLElement | null>): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const probe = shellRef === undefined ? createFixedEdgeProbe() : null;
    let collapseFrame: number | undefined;

    const resetPan = () => {
      const scroller = document.scrollingElement;
      if (scroller && scroller.scrollTop > 0) scroller.scrollTop = 0;
      if (window.scrollY > 0) window.scrollTo(0, 0);
    };

    const update = () => {
      // No typable element focused: no keyboard, so no overlap. Checked before
      // the geometry so a stale mid-animation height can never latch.
      if (!keyboardTarget(document.activeElement ?? null)) {
        setInset(0);
        resetPan();
        return;
      }
      const shell = shellRef === undefined ? probe : shellRef.current;
      // The applied padding lifts the composer inside the shell without
      // moving the shell's rect (its height is constrained by the 100dvh
      // ancestor), so reading the rect each event does not feed back. The
      // probe never moves either: nothing is ever applied to it.
      const shellBottom =
        shell !== null ? shell.getBoundingClientRect().bottom : window.innerHeight;
      const visibleBottom = viewport.offsetTop + viewport.height;
      const covered = shellBottom - visibleBottom;
      setInset(covered > 1 ? Math.round(covered) : 0);
      if (covered <= 1) resetPan();
    };

    // Moving between two fields keeps the keyboard up; re-measuring on the
    // focusout half of that hand-off would blink the composer down and back.
    //
    // The collapse waits a frame on purpose. iOS blurs the field partway
    // through a tap on a button, before the click dispatches: collapsing the
    // inset there drops the composer out from under the finger and the tap is
    // lost, which is why Send used to need pressing twice. Deferring lets the
    // click land first, and a re-focus in the meantime cancels it outright.
    const onFocusOut = (event: Event) => {
      const next = (event as FocusEvent).relatedTarget;
      if (keyboardTarget(next)) return;
      if (collapseFrame !== undefined) cancelAnimationFrame(collapseFrame);
      collapseFrame = requestAnimationFrame(() => {
        collapseFrame = undefined;
        update();
      });
    };

    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      if (collapseFrame !== undefined) cancelAnimationFrame(collapseFrame);
      probe?.remove();
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [shellRef]);
  return inset;
}
