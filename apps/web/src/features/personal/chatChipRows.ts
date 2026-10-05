import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBotThread, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isThreadLive, isThreadRateLimited, threadNeedsAttention } from "./botSummaries";
import { botThreadRows, type BotThreadRow } from "./botThreadRows";
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
  /** What a screen reader says besides the text: "needs you", "thinking", "current chat"... */
  readonly label: string;
}

export interface ChatChipModel {
  /** Temporary chip first (if any), then the owner's chats, oldest first. */
  readonly chips: ReadonlyArray<ChatChip>;
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

function stateWords(
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

function byCreation(left: BotThreadRow, right: BotThreadRow): number {
  const delta = epochMs(left.link.createdAt) - epochMs(right.link.createdAt);
  if (delta !== 0) return delta;
  return left.link.threadId < right.link.threadId
    ? -1
    : left.link.threadId > right.link.threadId
      ? 1
      : 0;
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
}): ChatChipModel {
  const { active, archived } = botThreadRows(
    input.botId,
    input.links,
    input.shells,
    input.relayThreadIds,
  );
  const taskChats = taskChatThreadIds(
    active.map((row) => row.link),
    input.tasks,
  );
  const owner = active.filter((row) => !taskChats.has(row.link.threadId)).toSorted(byCreation);

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
    return {
      threadId,
      text,
      kind,
      current,
      state,
      unread,
      label: words === null ? subject : `${subject}, ${words}`,
    };
  };

  const chips = owner.map((row) => toChip(row, "chat"));
  // The open chat is a task, routine or archived chat (opened from Team, a
  // notification or the task page): a temporary chip, first in the row, gone
  // once the owner switches away. Nothing stores it.
  if (!owner.some((row) => row.link.threadId === input.currentThreadId)) {
    const taskRow = active.find((row) => row.link.threadId === input.currentThreadId);
    const archivedRow = archived.find((row) => row.link.threadId === input.currentThreadId);
    if (taskRow !== undefined) chips.unshift(toChip(taskRow, "task"));
    else if (archivedRow !== undefined) chips.unshift(toChip(archivedRow, "archived"));
  }
  const turnsKey = owner
    .filter((row) => row.link.threadId !== input.currentThreadId)
    .map((row) => `${row.link.threadId}:${row.shell.latestTurn?.completedAt ?? ""}`)
    .join("|");
  return {
    chips,
    // The same number as "All chats N open" in the chat options menu and the rows of the bot's chat
    // list: every open chat with this bot, task and routine chats included (the strip itself only
    // lists the owner's chats). One definition, so the chip never disagrees with the list it opens.
    openCount: active.length,
    visible: chips.length >= MIN_CHIPS_FOR_STRIP,
    turnsKey,
  };
}
