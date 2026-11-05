import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { nextWakeAtMs, type ChatStateFields } from "@hbots/personal-client/bots/chatState";
import {
  readChatSeenState,
  subscribeChatSeen,
  type ChatSeenState,
} from "@hbots/personal-client/bots/unreadChats";

import {
  NOTICE_FADE_MS,
  TURNS_SETTLED_REFETCH_MS,
  turnsBaselineStep,
  wakeStep,
  type BulkNotice,
} from "./botThreadsModel";

export function useChatSeenState(): ChatSeenState {
  return useSyncExternalStore(subscribeChatSeen, readChatSeenState, readChatSeenState);
}

/**
 * The time snoozes are judged against: one timer for the nearest wake time.
 * When it fires the clock moves past it, so the chat is awake at once, and
 * `refresh` reads the list again, which brings the woken chat back unread at
 * the top. A phone that slept through a wake time catches up when the app
 * comes back to the foreground.
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
    const fire = () => {
      timer = null;
      setClock(Date.now());
      refreshRef.current();
    };
    const arm = () => {
      const step = wakeStep(wakeAt, Date.now());
      switch (step.kind) {
        case "wait":
          timer = setTimeout(arm, step.ms);
          return;
        case "fire":
          fire();
          return;
        default: {
          const unreachable: never = step;
          return unreachable;
        }
      }
    };
    arm();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" || wakeStep(wakeAt, Date.now()).kind !== "fire") return;
      if (timer !== null) clearTimeout(timer);
      fire();
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      subscription.remove();
    };
  }, [wakeAt]);

  return clock;
}

/** Calls `refresh` (trailing, one call for a burst) when `key` changes after its first value. */
export function useRefetchOnTurnsSettled(key: string, refresh: () => void): void {
  const baseline = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    const step = turnsBaselineStep(baseline.current, key);
    baseline.current = step.baseline;
    if (!step.refetch || timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      refreshRef.current();
    }, TURNS_SETTLED_REFETCH_MS);
  }, [key]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
}

/** A plain result fades after a while; one with failures stays until the next action. */
export function useBulkNotice(): readonly [BulkNotice | null, (next: BulkNotice | null) => void] {
  const [notice, setNotice] = useState<BulkNotice | null>(null);
  useEffect(() => {
    if (notice === null || notice.failed) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_FADE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}
