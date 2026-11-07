import type { EnvironmentThreadShell } from "./threadShell.ts";
import {
  isTeamLead,
  type PersonalBot,
  type PersonalBotThread,
  type PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isGroupRelayLink } from "../conversation/groupModel.ts";
import { isOwnerChat, taskChatThreadIds } from "./ownerChats.ts";

/**
 * Unread chats: the bot replied after the owner last had the chat open.
 * The server decides it (`personalBots.list` marks a link `unread` from the
 * newest assistant message against `last_viewed_at`, never on an archived
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
 * The unread chats by bot id. Bots with none are absent. A bot that shows
 * unread chats ({@link showsUnreadChats}) counts every unread chat; any other
 * bot counts only the chats the owner marked unread (or that woke from a
 */
export function unreadChatsByBot(input: {
  readonly bots: ReadonlyArray<Pick<PersonalBot, "botId" | "lead">>;
  readonly links: ReadonlyArray<PersonalBotThread>;
  /** The task feed, for the chats a task or a routine run made (`taskChatThreadIds`). */
  readonly tasks: ReadonlyArray<Pick<PersonalTask, "threadId" | "createdAt">>;
  readonly shells?: ReadonlyArray<EnvironmentThreadShell>;
  readonly relayThreadIds?: ReadonlySet<string>;
  readonly seen: ChatSeenState;
}): ReadonlyMap<string, ReadonlySet<string>> {
  const shown = new Set<string>(
    input.bots.filter((bot) => showsUnreadChats(bot)).map((bot) => bot.botId),
  );
  const out = new Map<string, Set<string>>();
  const relays = input.relayThreadIds ?? new Set<string>();
  const taskChats = taskChatThreadIds(input.links, input.tasks);
  const shellsById =
    input.shells === undefined
      ? null
      : new Map(input.shells.map((shell) => [shell.id as string, shell] as const));
  for (const link of input.links) {
    if (!shown.has(link.botId) && link.markedUnread !== true) continue;
    if (isGroupRelayLink(link, relays)) continue;
    // A chat the chips hide is not one the owner can reach from the bot's
    // header: it never counts towards the bot's dot.
    if (!isOwnerChat(link, taskChats)) continue;
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

// In memory only: a reload refetches the list, and by then the server has the
// viewed time (written when the chat was left), so nothing needs persisting.

let seenState: ChatSeenState = NO_CHAT_SEEN;
const listeners = new Set<() => void>();

function setSeenState(next: ChatSeenState): void {
  if (next === seenState) return;
  seenState = next;
  for (const listener of listeners) listener();
}

/**
 * Chats the owner marked unread from this device. The marking is only kept
 * if the next time the chat is left is not taken as having read it: marking
 * from inside the open chat and then leaving would otherwise write "seen up
 * to now" and hide the very chat just marked.
 */
const markedUnreadHere = new Set<string>();

/**
 * "Mark unread" on this device: forgets what this device saw of the chat, so
 * the unread flag from the list shows again, and keeps the leave of the chat
 * (it may be open right now) from marking it seen. Opening the chat again
 * clears it as any open does.
 */
export function clearChatSeen(threadId: string): void {
  markedUnreadHere.add(threadId);
  if (!seenState.seenUpToMs.has(threadId)) return;
  const seenUpToMs = new Map(seenState.seenUpToMs);
  seenUpToMs.delete(threadId);
  setSeenState({ ...seenState, seenUpToMs });
}

/** The chat is open and visible (`open` true), or no longer is. */
export function markChatOpen(threadId: string, open: boolean, nowMs: number = Date.now()): void {
  if (open) {
    markedUnreadHere.delete(threadId);
    if (seenState.openThreadId === threadId) return;
    setSeenState({ ...seenState, openThreadId: threadId });
    return;
  }
  if (markedUnreadHere.delete(threadId)) {
    // Marked unread while it was open: leaving is not reading it.
    const kept = new Map(seenState.seenUpToMs);
    kept.delete(threadId);
    setSeenState({
      openThreadId: seenState.openThreadId === threadId ? null : seenState.openThreadId,
      seenUpToMs: kept,
    });
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
  markedUnreadHere.clear();
  setSeenState(NO_CHAT_SEEN);
}

export function subscribeChatSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current value, outside React (tests). */
export function readChatSeenState(): ChatSeenState {
  return seenState;
}
