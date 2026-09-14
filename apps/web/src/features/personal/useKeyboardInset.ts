import type { RefObject } from "react";
import { useEffect, useState } from "react";

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
 * Leftover document pan is reset only when the shell is fully visible again
 * (overlap <= 1); resetting while typing drags the composer back under the
 * keyboard.
 */
export function useKeyboardInset(shellRef?: RefObject<HTMLElement | null>): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const shell = shellRef?.current ?? null;
      // The applied padding lifts the composer inside the shell without
      // moving the shell's rect (its height is constrained by the 100dvh
      // ancestor), so reading the rect each event does not feed back.
      const shellBottom =
        shell !== null ? shell.getBoundingClientRect().bottom : window.innerHeight;
      const visibleBottom = viewport.offsetTop + viewport.height;
      const covered = shellBottom - visibleBottom;
      setInset(covered > 1 ? Math.round(covered) : 0);
      if (covered <= 1) {
        const scroller = document.scrollingElement;
        if (scroller && scroller.scrollTop > 0) scroller.scrollTop = 0;
        if (window.scrollY > 0) window.scrollTo(0, 0);
      }
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [shellRef]);
  return inset;
}
