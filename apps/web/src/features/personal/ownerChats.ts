import type { PersonalBotThread, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isChatPinned } from "./chatState";

/**
 * Which chats are the owner's own, and nothing else: the chat chips show
 * exactly these, the unread dot on a bot's row counts exactly these, and the
 * bot's chat list marks exactly these. One definition, because a chat the chips
 * hide must never light a dot somewhere else (2026-10-16: a routine chat the
 * owner never opened lit CTO's row while it appeared in no chip).
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
 * chat. Mirrors the server's own rule in taskChatAutoArchivePolicy.ts
 * (`task.created_at <= thread.created_at`). A task the feed no longer holds
 * cannot be seen here, so a very old task chat can slip in; most are
 * archived after 48 hours anyway.
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
 * a steer, an auto-continue and a release notice never count; see
 * taskChatAutoArchivePolicy.ts). It must also land after the chat was made: a
 * task chat is created with its task, so anything at or before that is the
 * task's own start, not the owner writing in it. (A pin makes it his too, and
 * the caller reads that off the link.) An older server that sends no
 * `lastOwnerMessageAt` simply never promotes on this rule.
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
 * me", and the one thing that brings a task chat into the chips by itself).
 * `taskChatIds` is `taskChatThreadIds` for the same list; a chat that is not in
 * it never needs the link's own times.
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
 * list when the owner writes, so the chat screen asks once on this key and the
 * refreshed link then carries his message. Non-null means "read the list
 * again"; the same key never asks twice, and a link that has caught up (or a
 * pin, which promotes on its own) makes it null, so it cannot loop.
 *
 * The message ids are the server's own rule: an app-written `personal-...`
 * turn (a task brief, a steer, a continuation) is never the owner's.
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
