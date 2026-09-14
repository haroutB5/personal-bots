import { useEffect, useState } from "react";

/**
 * Height the on-screen keyboard covers. Chromium resizes the layout viewport
 * itself (`interactive-widget=resizes-content`), which leaves this at 0; iOS
 * Safari only shrinks the visual viewport, so the composer is lifted by the
 * difference.
 *
 * iOS also pans the document itself to reveal the focused input (the shell's
 * `overflow-hidden` does not stop the browser's own pan) and can leave that
 * pan behind after the keyboard closes, which shoves the header off-screen
 * and opens a dead strip under the composer. Whenever the viewport reports
 * the keyboard gone, any leftover document scroll is put back to 0.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      setInset(covered > 1 ? Math.round(covered) : 0);
      // `covered` alone cannot distinguish "keyboard closed" from "keyboard
      // open but iOS panned the visual viewport down" (offsetTop eats the
      // difference). Resetting during that pan drags the focused composer
      // back under the keyboard, so the scroll restore keys on the raw
      // height delta instead.
      const keyboardClosed = window.innerHeight - viewport.height <= 1;
      if (keyboardClosed) {
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
  }, []);
  return inset;
}
