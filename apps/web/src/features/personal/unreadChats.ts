import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  markChatOpen,
  subscribeChatSeen,
  readChatSeenState,
  type ChatSeenState,
} from "@hbots/personal-client/bots/unreadChats";

export * from "@hbots/personal-client/bots/unreadChats";

export function useChatSeenState(): ChatSeenState {
  return useSyncExternalStore(subscribeChatSeen, readChatSeenState, readChatSeenState);
}

/**
 * Marks the chat open while `active` and the page is visible, and read up to
 * the moment it closes or the page hides.
 */
export function useMarkChatSeen(threadId: string, active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    const sync = () => markChatOpen(threadId, document.visibilityState === "visible");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      markChatOpen(threadId, false);
    };
  }, [threadId, active]);
}

/** How long after a turn settles a chat list refetches (one fetch for a burst). */
export const UNREAD_REFETCH_DEBOUNCE_MS = 400;

/**
 * Calls `refresh` (trailing, debounced) when `key` changes after its first
 * non-empty value.
 */
export function useRefetchOnTurnsSettled(key: string, refresh: () => void): void {
  const baseline = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (key === "") return;
    if (baseline.current === null || baseline.current === key) {
      baseline.current = key;
      return;
    }
    baseline.current = key;
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      refreshRef.current();
    }, UNREAD_REFETCH_DEBOUNCE_MS);
  }, [key]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
}
