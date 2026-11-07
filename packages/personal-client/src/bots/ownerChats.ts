import type { PersonalBotThread, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isChatPinned } from "./chatState.ts";

/**
 * Which chats are the owner's own, and nothing else: the chat chips show
 * exactly these, the unread dot on a bot's row counts exactly these, and the
 * bot's chat list marks exactly these. One definition, because a chat the chips
 */

/** A task's chat is made when the task is, so it is never older than the task by more than this. */
export const TASK_CHAT_SLACK_MS = 5_000;

function epochMs(value: DateTime.Utc): number {
  return DateTime.toEpochMillis(value);
}

/**
 * Chats made for a task or a routine run: a task of the feed points at the
 * chat and was created at or before it. A routine that runs inside an existing
 * owner chat leaves that chat alone, because its tasks are newer than the
 */
export function taskChatThreadIds(
  links: ReadonlyArray<Pick<PersonalBotThread, "threadId" | "createdAt">>,
  tasks: ReadonlyArray<Pick<PersonalTask, "threadId" | "createdAt">>,
): ReadonlySet<string> {
  const earliestTaskMs = new Map<string, number>();
  for (const task of tasks) {
    if (task.threadId === null) continue;
    const at = epochMs(task.createdAt);
    const known = earliestTaskMs.get(task.threadId);
    if (known === undefined || at < known) earliestTaskMs.set(task.threadId, at);
  }
  const out = new Set<string>();
  for (const link of links) {
    const taskAt = earliestTaskMs.get(link.threadId);
    if (taskAt !== undefined && taskAt <= epochMs(link.createdAt) + TASK_CHAT_SLACK_MS) {
      out.add(link.threadId);
    }
  }
  return out;
}

/**
 * Whether a chat made for a task or a routine run is one the owner took over
 * himself. It reads the server's own rule off the link, `lastOwnerMessageAt`
 * (`role = 'user'` and not an app-written `personal-...` turn, so a task brief,
 */
export function taskChatTakenOver(
  link: Pick<PersonalBotThread, "createdAt" | "lastOwnerMessageAt">,
): boolean {
  const at = link.lastOwnerMessageAt;
  if (at === null || at === undefined) return false;
  return DateTime.toEpochMillis(at) > epochMs(link.createdAt) + TASK_CHAT_SLACK_MS;
}

/**
 * Whether a chat is one of the owner's own. It is, unless a task or a routine
 * run made it and he never made it his: he wrote in it himself
 * (`taskChatTakenOver`), he pinned it, or he marked it unread (his own "remind
 */
export function isOwnerChat(
  link: Pick<
    PersonalBotThread,
    "threadId" | "createdAt" | "lastOwnerMessageAt" | "pinnedAt" | "markedUnread"
  >,
  taskChatIds: ReadonlySet<string>,
): boolean {
  if (!taskChatIds.has(link.threadId)) return true;
  return isChatPinned(link) || taskChatTakenOver(link) || link.markedUnread === true;
}

/** How long to wait before reading the list again, in case the write and the read crossed. */
export const OWNER_WRITE_REFRESH_RETRY_MS = 3_000;

/**
 * The owner's own newest message in the chat he has open, when the bots list
 * has not caught up with it yet. `lastOwnerMessageAt` comes over the list
 * (`taskChatTakenOver` is what promotes the chip) and nothing refetches the
 */
export function ownerWriteRefreshKey(input: {
  readonly link: Pick<
    PersonalBotThread,
    "threadId" | "createdAt" | "lastOwnerMessageAt" | "pinnedAt"
  > | null;
  /** The chats a task or routine run made (see `taskChatThreadIds`). */
  readonly taskChatIds: ReadonlySet<string>;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly createdAt: string;
  }>;
}): string | null {
  const { link } = input;
  if (link === null || !input.taskChatIds.has(link.threadId)) return null;
  if (isChatPinned(link) || link.lastOwnerMessageAt != null) return null;
  const createdMs = epochMs(link.createdAt) + TASK_CHAT_SLACK_MS;
  let newest: { readonly id: string; readonly at: number } | null = null;
  for (const message of input.messages) {
    if (message.role !== "user" || message.id.startsWith("personal-")) continue;
    const at = Date.parse(message.createdAt);
    if (!Number.isFinite(at) || at <= createdMs) continue;
    if (newest === null || at > newest.at) newest = { id: message.id, at };
  }
  return newest === null ? null : `${link.threadId}@${newest.id}`;
}
