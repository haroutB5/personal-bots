import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { perfOptimizationOn } from "./perfFlags";

const BOTS_PATH = "/bots";

/** The Bots list itself. */
export function isBotsListPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === BOTS_PATH;
}

/**
 * Pages the phone opens on top of the Bots list: a bot chat, a bot's page and
 * its edit form, a group, the Team screen, the new-bot/group/team forms and
 * settings. Back from all of them leads (directly or through the Team screen)
 * to the list, so the list stays mounted under them. Tasks, Computer and Files
 * are other tabs: leaving for one of those unmounts it.
 */
export function keepsBotsListUnder(pathname: string): boolean {
  return pathname.startsWith(`${BOTS_PATH}/`);
}

export interface KeptBotsList {
  /** The list is mounted by the shell (shown or hidden), not by the /bots route. */
  readonly kept: boolean;
  /** The list is what the column shows. */
  readonly shown: boolean;
}

/**
 * Phone shell only: whether the Bots list stays mounted (hidden, in React
 * Activity) while a page opened from it is on top (1.60.0). Opening a chat then
 * hides the list instead of unmounting it, and Back shows it again instead of
 * mounting it, at its scroll position. It is kept only once the list has been
 * shown in this visit to the tab, so a relaunch straight into a chat does not
 * build a list nobody asked for. Kill switch "keep-list" (read once per load):
 * off, the /bots route mounts the list and every tap unmounts it.
 */
export function useKeptBotsList(pathname: string, wide: boolean): KeptBotsList {
  const [enabled] = useState(() => perfOptimizationOn("keep-list"));
  const shown = isBotsListPath(pathname);
  const inTab = shown || keepsBotsListUnder(pathname);
  const [seen, setSeen] = useState(false);
  const active = enabled && !wide;
  if (active && shown && !seen) setSeen(true);
  else if (seen && (!inTab || !active)) setSeen(false);
  const kept = active && inTab && (shown || seen);
  return { kept, shown: kept && shown };
}

/**
 * The list's scroll position in the shared column scroller, saved while the
 * list is on screen. Read by the swipe-back underlay so the list it draws
 * under a chat sits where the real one will.
 */
let savedScrollTop = 0;

export function keptBotsListScrollTop(): number {
  return savedScrollTop;
}

/**
 * The phone column has one scroller for every routed page. While the list is
 * shown its position is saved; when a page covers it, that page starts at the
 * top; when the list shows again (Back, the swipe, the browser's Back) it is
 * put back before the frame paints.
 */
export function useKeptBotsListScroll(
  scrollerRef: RefObject<HTMLElement | null>,
  list: KeptBotsList,
): void {
  const shownRef = useRef(list.shown);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!list.kept || scroller === null) return;
    const onScroll = () => {
      if (shownRef.current) savedScrollTop = scroller.scrollTop;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [list.kept, scrollerRef]);

  useLayoutEffect(() => {
    shownRef.current = list.shown;
    const scroller = scrollerRef.current;
    if (!list.kept) {
      savedScrollTop = 0;
      return;
    }
    if (scroller === null) return;
    if (list.shown) {
      scroller.scrollTop = savedScrollTop;
      return;
    }
    // Hidden: the page on top starts at the top. In the next frame's rAF,
    // still before it paints: touching scrollTop here forced a layout inside
    // the opening tap (37 ms at 4x CPU). A page that restores its own position
    // (the Team screen) has moved the scroller by then and is left alone.
    const frame = requestAnimationFrame(() => {
      if (scroller.scrollTop === savedScrollTop) scroller.scrollTop = 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [list.kept, list.shown, scrollerRef]);
}
