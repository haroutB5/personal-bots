import { useEffect, useRef, useState } from "react";

import { nextWakeAtMs, type ChatStateFields } from "./chatState";

/** Browsers hold a timer's delay in 32 bits; a longer wait is made in steps. */
export const MAX_TIMER_MS = 2_147_483_647;
/** A little after the wake time, so the server has crossed it too when the list is asked. */
export const WAKE_SLACK_MS = 400;

/**
 * The time snoozes are judged against, kept right while the app is open: one
 * timer for the nearest wake time among `items`. When it fires, the clock
 * moves past that time (so the chat is treated as awake at once) and `refresh`
 * refetches the list, which brings the woken chat back unread at the top. A
 * phone that slept through a wake time catches up when the page shows again.
 *
 * Pass the same value as `nowMs` to `isChatSnoozed`, `botThreadRows`,
 * `buildBotSummaries` and `buildChatChips`.
 */
export function useSnoozeWakeClock(
  items: ReadonlyArray<Pick<ChatStateFields, "snoozedUntil">> | null | undefined,
  refresh: () => void,
): number {
  const [clock, setClock] = useState(() => Date.now());
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  const wakeAt = items === null || items === undefined ? null : nextWakeAtMs(items, clock);

  useEffect(() => {
    if (wakeAt === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      const wait = wakeAt + WAKE_SLACK_MS - Date.now();
      if (wait > 0) {
        timer = setTimeout(arm, Math.min(wait, MAX_TIMER_MS));
        return;
      }
      timer = null;
      setClock(Date.now());
      refreshRef.current();
    };
    arm();
    // Timers stop in a hidden page: check again as it shows.
    const hasDocument = typeof document !== "undefined";
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() >= wakeAt) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        setClock(Date.now());
        refreshRef.current();
      }
    };
    if (hasDocument) document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== null) clearTimeout(timer);
      if (hasDocument) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [wakeAt]);

  return clock;
}
