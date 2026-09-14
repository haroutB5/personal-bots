import { useEffect } from "react";

/**
 * Mirror `document.hidden` onto `<html data-hidden>`.
 *
 * The one continuous animation on this surface (the working bot avatar) pauses
 * on that attribute, so a backgrounded tab stops repainting without any
 * component re-rendering. Mounted once by `PersonalShell`.
 */
export function useHiddenRootAttribute(): void {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      if (document.hidden) {
        root.setAttribute("data-hidden", "");
      } else {
        root.removeAttribute("data-hidden");
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      root.removeAttribute("data-hidden");
    };
  }, []);
}
