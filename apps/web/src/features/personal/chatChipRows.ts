import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBotThread, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isThreadLive, isThreadRateLimited, threadNeedsAttention } from "./botSummaries";
import { botThreadRows, type BotThreadRow } from "./botThreadRows";
import { isChatPinned } from "./chatState";
import { conversationChatTitle } from "./ConversationHeaderName";
import { isTurnThinking } from "./conversationModel";
import { isChatUnread, type ChatSeenState } from "./unreadChats";

/**
 * The chat chips in a bot's chat header: one pill per chat the owner started
 * with this bot, so a person with a chat per app (matchday, hbots, Main team)
 * reaches any of them in one tap. All of it is derived from what the chat
 * screen already holds: the bots list, the thread shells and the task feed.
 */

/** A task's chat is made when the task is, so it is never older than the task by more than this. */
export const TASK_CHAT_SLACK_MS = 5_000;
/** The row shows from this many chips. One chat leaves the header exactly as it was. */
export const MIN_CHIPS_FOR_STRIP = 2;
const UNTITLED_CHIP = "New chat";

/**
 * Chips draw one state each, the strongest first. `unread` is also a flag
 * on the chip (heavier text) whatever dot is drawn.
 */
export type ChatChipState =
  | "needs_you"
  | "rate_limited"
  | "working"
  | "waiting"
  | "unread"
  | "idle";

export type ChatChipKind = "chat" | "task" | "archived";

export interface ChatChip {
  readonly threadId: string;
  /** The text on the pill: the chat's title, or "Task · title" on a temporary chip. */
  readonly text: string;
  readonly kind: ChatChipKind;
  readonly current: boolean;
  readonly state: ChatChipState;
  readonly unread: boolean;
  /** The owner pinned this chat: it sits first and draws a small pin. */
  readonly pinned: boolean;
  /** What a screen reader says besides the text: "needs you", "thinking", "current chat"... */
  readonly label: string;
}

export interface ChatChipModel {
  /**
   * Temporary chip first (if any), then the pinned chats, then the owner's
   * other chats, each newest activity first: the order of the bot's chat list
   * (botThreadRows), minus task and routine chats the owner never used (a task
   * chat he pinned or wrote in himself is one of his). Snoozed chats are not
   * here (unless one is the open chat, as a temporary chip). The screen keeps
   * the order still while the owner stays in the bot's chats (chatChipOrder.ts).
   */
  readonly chips: ReadonlyArray<ChatChip>;
  /** The open chat's temporary chip (task, archived or snoozed chat), or null. It is `chips[0]`. */
  readonly temporary: ChatChip | null;
  /** The owner's own chats, in the order `chips` has them after the temporary chip. */
  readonly ownerChips: ReadonlyArray<ChatChip>;
  /** Open chats the owner started with this bot: the N of "All N". */
  readonly openCount: number;
  /** The row shows (and the header takes its taller layout). */
  readonly visible: boolean;
  /**
   * Changes when another chip's chat finishes a turn: the screen refetches the
   * list on it, because the list is what carries the unread flag.
   */
  readonly turnsKey: string;
}

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

/** The one dot a chip draws: needs you > rate limited > working > waiting on a bot > unread. */
export function chatChipState(input: {
  readonly shell: EnvironmentThreadShell;
  readonly waiting: boolean;
  readonly unread: boolean;
}): ChatChipState {
  if (threadNeedsAttention(input.shell)) return "needs_you";
  if (isThreadRateLimited(input.shell)) return "rate_limited";
  if (isThreadLive(input.shell)) return "working";
  if (input.waiting) return "waiting";
  if (input.unread) return "unread";
  return "idle";
}

export function stateWords(
  state: ChatChipState,
  shell: EnvironmentThreadShell,
  waitingLabel: string | null,
): string | null {
  switch (state) {
    case "needs_you":
      return "needs you";
    case "rate_limited":
      return "rate limited";
    case "working":
      return isTurnThinking(shell) ? "thinking" : "working";
    case "waiting": {
      const text = waitingLabel ?? "Waiting on a task";
      return text.charAt(0).toLowerCase() + text.slice(1);
    }
    case "unread":
      return "unread";
    case "idle":
      return null;
  }
}

function chipTitle(shell: EnvironmentThreadShell): string {
  return conversationChatTitle(shell.title) ?? UNTITLED_CHIP;
}

export function buildChatChips(input: {
  readonly botId: string;
  readonly currentThreadId: string;
  readonly links: ReadonlyArray<PersonalBotThread>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly relayThreadIds: ReadonlySet<string>;
  readonly tasks: ReadonlyArray<PersonalTask>;
  /** Chats waiting on another bot's task, with the words the header uses (waitingLabelsByThread). */
  readonly waitingLabels: ReadonlyMap<string, string>;
  readonly seen: ChatSeenState;
  /** The time a snooze is judged against (the screen's wake clock). */
  readonly nowMs?: number | undefined;
}): ChatChipModel {
  const { active, archived, snoozed } = botThreadRows(
    input.botId,
    input.links,
    input.shells,
    input.relayThreadIds,
    input.nowMs,
  );
  const taskChats = taskChatThreadIds(
    active.map((row) => row.link),
    input.tasks,
  );
  // `active` is pinned first, then newest activity first (the All chats list's order): the
  // chips use it as it is. A task or routine chat the owner made his own (he pinned it, or
  // wrote in it himself after the task's own first turn) is an ordinary chip: same order,
  // plain title, no temporary chip while it is open. Every other task chat stays temporary.
  const owner = active.filter(
    (row) =>
      !taskChats.has(row.link.threadId as string) ||
      isChatPinned(row.link) ||
      taskChatTakenOver(row.link),
  );

  const toChip = (row: BotThreadRow, kind: ChatChipKind): ChatChip => {
    const threadId = row.link.threadId as string;
    const current = threadId === input.currentThreadId;
    const waitingLabel = input.waitingLabels.get(threadId) ?? null;
    const unread = !current && isChatUnread(row.link, input.seen, row.shell);
    const state = current
      ? "idle"
      : chatChipState({ shell: row.shell, waiting: waitingLabel !== null, unread });
    const title = chipTitle(row.shell);
    const text =
      kind === "task" ? `Task · ${title}` : kind === "archived" ? `Archived · ${title}` : title;
    const subject =
      kind === "task" ? `Task: ${title}` : kind === "archived" ? `Archived: ${title}` : title;
    const words = current ? "current chat" : stateWords(state, row.shell, waitingLabel);
    const pinned = isChatPinned(row.link);
    const spoken = [pinned ? "pinned" : null, words].filter((part) => part !== null).join(", ");
    return {
      threadId,
      text,
      kind,
      current,
      state,
      unread,
      pinned,
      label: spoken === "" ? subject : `${subject}, ${spoken}`,
    };
  };

  const ownerChips = owner.map((row) => toChip(row, "chat"));
  let temporary: ChatChip | null = null;
  // The open chat is a task or routine chat the owner has not used, or an
  // archived chat (opened from Team, a notification or the task page): a
  // temporary chip, first in the row, gone once the owner switches away.
  // Nothing stores it.
  if (!owner.some((row) => row.link.threadId === input.currentThreadId)) {
    const taskRow = active.find((row) => row.link.threadId === input.currentThreadId);
    const archivedRow = archived.find((row) => row.link.threadId === input.currentThreadId);
    // A snoozed chat opened from the Snoozed section: an ordinary chip while it is open.
    const snoozedRow = snoozed.find((row) => row.link.threadId === input.currentThreadId);
    if (snoozedRow !== undefined) temporary = toChip(snoozedRow, "chat");
    else if (taskRow !== undefined) temporary = toChip(taskRow, "task");
    else if (archivedRow !== undefined) temporary = toChip(archivedRow, "archived");
  }
  const chips = temporary === null ? ownerChips : [temporary, ...ownerChips];
  const turnsKey = owner
    .filter((row) => row.link.threadId !== input.currentThreadId)
    .map((row) => `${row.link.threadId}:${row.shell.latestTurn?.completedAt ?? ""}`)
    .join("|");
  return {
    chips,
    temporary,
    ownerChips,
    // The same number as "All chats N open" in the chat options menu and the rows of the bot's chat
    // list: every open chat with this bot, task and routine chats included (the strip itself only
    // lists the owner's chats). One definition, so the chip never disagrees with the list it opens.
    openCount: active.length,
    visible: chips.length >= MIN_CHIPS_FOR_STRIP,
    turnsKey,
  };
}
