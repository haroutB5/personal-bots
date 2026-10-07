import type { PersonalBotThreadsBatchResult } from "@t3tools/contracts";

import {
  allSelected,
  bulkDeleteConfirmLabel as deleteConfirmLabel,
  bulkResultNotice as resultNotice,
  type BulkNoun,
  type BulkVerb,
  countOf,
  DELETE_VERB,
  selectedCountLabel as countLabel,
  toggleSelection,
  visibleSelection,
} from "./bulkSelection";

/** Which part of a bot's chat list select mode covers: Select all never reaches the other. */
export type ChatSection = "active" | "archived";

export type BulkChatAction =
  | "archive"
  | "unarchive"
  | "delete"
  | "pin"
  | "unpin"
  | "snooze"
  | "wake"
  | "markUnread";

/** The actions that change a chat's state (`personalBots.updateThreads`) rather than archive or delete it. */
export type ChatStateAction = Extract<
  BulkChatAction,
  "pin" | "unpin" | "snooze" | "wake" | "markUnread"
>;

export function isChatStateAction(action: BulkChatAction): action is ChatStateAction {
  return (
    action === "pin" ||
    action === "unpin" ||
    action === "snooze" ||
    action === "wake" ||
    action === "markUnread"
  );
}

const CHAT: BulkNoun = { one: "chat", many: "chats" };

/** Adds the chat if it is not selected, removes it if it is. */
export const toggleChatSelection = toggleSelection;

/**
 * The selection limited to chats still in the section: a chat deleted,
 * archived or moved elsewhere (another device, a task) stops counting, so
 * "N selected" and the action only ever cover rows on screen.
 */
export { visibleSelection };

/** Every chat in the section is selected (and there is at least one). */
export const allChatsSelected = allSelected;

export function selectedCountLabel(count: number): string {
  return countLabel(count, CHAT);
}

/**
 * The one confirm a bulk delete asks. A working chat is deleted the way a
 * single delete does it (its task is stopped first), so the confirm says so
 * rather than skipping it.
 */
export function bulkDeleteConfirmMessage(count: number, workingCount: number): string {
  const lines = [
    `Delete ${countOf(count, CHAT)}?`,
    "They're removed permanently and can't be undone.",
  ];
  if (workingCount > 0) {
    lines.push(
      workingCount === 1
        ? "1 of them is still working; its work stops."
        : `${workingCount} of them are still working; their work stops.`,
    );
  }
  return lines.join("\n");
}

export function bulkDeleteConfirmLabel(count: number): string {
  return deleteConfirmLabel(count, CHAT);
}

const VERB: Record<BulkChatAction, BulkVerb> = {
  archive: { done: "Archived", failed: "archived" },
  unarchive: { done: "Unarchived", failed: "unarchived" },
  delete: DELETE_VERB,
  pin: { done: "Pinned", failed: "pinned" },
  unpin: { done: "Unpinned", failed: "unpinned" },
  snooze: { done: "Snoozed", failed: "snoozed" },
  wake: { done: "Woke", failed: "woken" },
  markUnread: { done: "Marked", failed: "marked unread" },
};

/**
 * What the batch did, in one line: "Deleted 12 chats." or, when some were
 * refused, "Deleted 10 chats. 2 couldn't be deleted: <first reason>".
 */
export function bulkResultNotice(
  action: BulkChatAction,
  result: PersonalBotThreadsBatchResult,
): { readonly text: string; readonly failed: boolean } {
  const notice = resultNotice(
    VERB[action],
    CHAT,
    result.done.length,
    result.failed.map((entry) => entry.message),
  );
  // "Marked 3 chats." reads as nothing: "3 chats marked unread."
  if (action === "markUnread") {
    return { ...notice, text: notice.text.replace(/^Marked (\d+ chats?)\./, "$1 marked unread.") };
  }
  // A chat whose name another open chat took while it was archived came back
  // under a number: say so.
  const renamed = action === "unarchive" ? (result.renamed ?? []) : [];
  const [only] = renamed;
  if (only === undefined) return notice;
  const sentence =
    renamed.length === 1
      ? unarchiveRenamedNotice(only.from, only.title)
      : `${renamed.length} chats got a number after their name because it is in use now.`;
  return { ...notice, text: `${notice.text} ${sentence}` };
}

/** One chat unarchived under a number, for the notice: `“Main” is in use now, so this chat is now “Main 3”.` */
export function unarchiveRenamedNotice(from: string, to: string): string {
  return `“${from}” is in use now, so this chat is now “${to}”.`;
}
