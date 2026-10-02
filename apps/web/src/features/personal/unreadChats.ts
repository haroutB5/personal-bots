import { useEffect, useRef, useSyncExternalStore } from "react";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isTeamLead, type PersonalBot, type PersonalBotThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isGroupRelayLink } from "./groupModel";

/**
 * Unread chats: the bot replied after the owner last had the chat open.
 *
 * The server decides it (`personalBots.list` marks a link `unread` from the
 * newest assistant message against `last_viewed_at`, never on an archived
 * chat or a group relay). This device then clears it the moment the owner
 * opens the chat, without waiting for a refetch: the chat that is open and
 * visible is never unread, and a chat the owner left is read up to the moment
 * they left it.
 */

/**
 * Which bots show unread chats. Team leads today (CTO, CFO): the bots the
 * owner hands work to and that report back across many chats. One place to
 * switch it on for other bots later.
 */
export function showsUnreadChats(bot: Pick<PersonalBot, "lead">): boolean {
  return isTeamLead(bot);
}

export interface ChatSeenState {
  /** The chat open and visible on this device right now. */
  readonly openThreadId: string | null;
  /** Per chat: replies at or before this time (epoch ms) have been seen here. */
  readonly seenUpToMs: ReadonlyMap<string, number>;
}

export const NO_CHAT_SEEN: ChatSeenState = { openThreadId: null, seenUpToMs: new Map() };

/** Whether one linked chat counts as unread on this device. */
export function isChatUnread(
  link: Pick<
    PersonalBotThread,
    "threadId" | "archivedAt" | "groupRelay" | "unread" | "lastReplyAt"
  >,
  seen: ChatSeenState,
  shell?: Pick<EnvironmentThreadShell, "archivedAt"> | null,
): boolean {
  if (link.unread !== true || link.lastReplyAt === undefined) return false;
  if (link.archivedAt !== null || (shell?.archivedAt ?? null) !== null) return false;
  if (link.groupRelay === true) return false;
  if (seen.openThreadId === link.threadId) return false;
  const seenUpTo = seen.seenUpToMs.get(link.threadId);
  return seenUpTo === undefined || DateTime.toEpochMillis(link.lastReplyAt) > seenUpTo;
}

/**
 * The unread chats of every bot that shows them ({@link showsUnreadChats}),
 * by bot id. Bots with none are absent. Reads only the list the Bots screen
 * already has: no request per row.
 */
export function unreadChatsByBot(input: {
  readonly bots: ReadonlyArray<Pick<PersonalBot, "botId" | "lead">>;
  readonly links: ReadonlyArray<PersonalBotThread>;
  readonly shells?: ReadonlyArray<EnvironmentThreadShell>;
  readonly relayThreadIds?: ReadonlySet<string>;
  readonly seen: ChatSeenState;
}): ReadonlyMap<string, ReadonlySet<string>> {
  const shown = new Set<string>(
    input.bots.filter((bot) => showsUnreadChats(bot)).map((bot) => bot.botId),
  );
  const out = new Map<string, Set<string>>();
  if (shown.size === 0) return out;
  const relays = input.relayThreadIds ?? new Set<string>();
  const shellsById =
    input.shells === undefined
      ? null
      : new Map(input.shells.map((shell) => [shell.id as string, shell] as const));
  for (const link of input.links) {
    if (!shown.has(link.botId) || isGroupRelayLink(link, relays)) continue;
    // A chat whose shell has not arrived yet is not listed anywhere either.
    const shell = shellsById === null ? null : shellsById.get(link.threadId);
    if (shell === undefined) continue;
    if (!isChatUnread(link, input.seen, shell)) continue;
    const ids = out.get(link.botId);
    if (ids === undefined) out.set(link.botId, new Set([link.threadId]));
    else ids.add(link.threadId);
  }
  return out;
}

/** "3 unread chats" / "1 unread chat", for the row's and tile's accessible name. */
export function unreadChatsLabel(count: number): string {
  return `${count} unread ${count === 1 ? "chat" : "chats"}`;
}

// --- This device's seen state -------------------------------------------------
// In memory only: a reload refetches the list, and by then the server has the
// viewed time (written when the chat was left), so nothing needs persisting.

let seenState: ChatSeenState = NO_CHAT_SEEN;
const listeners = new Set<() => void>();

function setSeenState(next: ChatSeenState): void {
  if (next === seenState) return;
  seenState = next;
  for (const listener of listeners) listener();
}

/** The chat is open and visible (`open` true), or no longer is. */
export function markChatOpen(threadId: string, open: boolean, nowMs: number = Date.now()): void {
  if (open) {
    if (seenState.openThreadId === threadId) return;
    setSeenState({ ...seenState, openThreadId: threadId });
    return;
  }
  // Leaving: everything up to now has been seen. The server stamps the same
  // moment, but a list fetched before that write lands must not relight it.
  const seenUpToMs = new Map(seenState.seenUpToMs);
  seenUpToMs.set(threadId, Math.max(seenUpToMs.get(threadId) ?? 0, nowMs));
  setSeenState({
    openThreadId: seenState.openThreadId === threadId ? null : seenState.openThreadId,
    seenUpToMs,
  });
}

/** Test hook: forget everything this device saw. */
export function resetChatSeenState(): void {
  setSeenState(NO_CHAT_SEEN);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current value, outside React (tests). */
export function readChatSeenState(): ChatSeenState {
  return seenState;
}

export function useChatSeenState(): ChatSeenState {
  return useSyncExternalStore(subscribe, readChatSeenState, readChatSeenState);
}

/**
 * Marks the chat open while `active` and the page is visible, and read up to
 * the moment it closes or the page hides. The conversation screen calls it
 * with the same flag it reports viewing with.
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
 * non-empty value: a bot's chat list keys it on its chats' finished turns.
 * The first value is the baseline, so opening the screen costs no fetch.
 */
export function useRefetchOnTurnsSettled(key: string, refresh: () => void): void {
  const baseline = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
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
