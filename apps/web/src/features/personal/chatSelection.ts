import type { PersonalBotThreadsBatchResult } from "@t3tools/contracts";

/** Which part of a bot's chat list select mode covers: Select all never reaches the other. */
export type ChatSection = "active" | "archived";

export type BulkChatAction = "archive" | "unarchive" | "delete";

/** Adds the chat if it is not selected, removes it if it is. */
export function toggleChatSelection(
  selected: ReadonlySet<string>,
  threadId: string,
): ReadonlySet<string> {
  const next = new Set(selected);
  if (next.has(threadId)) next.delete(threadId);
  else next.add(threadId);
  return next;
}

/**
 * The selection limited to chats still in the section: a chat deleted,
 * archived or moved elsewhere (another device, a task) stops counting, so
 * "N selected" and the action only ever cover rows on screen.
 */
export function visibleSelection(
  selected: ReadonlySet<string>,
  sectionIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return sectionIds.filter((id) => selected.has(id));
}

/** Every chat in the section is selected (and there is at least one). */
export function allChatsSelected(
  selected: ReadonlySet<string>,
  sectionIds: ReadonlyArray<string>,
): boolean {
  return sectionIds.length > 0 && sectionIds.every((id) => selected.has(id));
}

export function selectedCountLabel(count: number): string {
  return count === 0 ? "Select chats" : `${count} selected`;
}

function chats(count: number): string {
  return count === 1 ? "1 chat" : `${count} chats`;
}

/**
 * The one confirm a bulk delete asks. A working chat is deleted the way a
 * single delete does it (its task is stopped first), so the confirm says so
 * rather than skipping it.
 */
export function bulkDeleteConfirmMessage(count: number, workingCount: number): string {
  const lines = [`Delete ${chats(count)}?`, "They're removed permanently and can't be undone."];
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
  return `Delete ${chats(count)}`;
}

const DONE_VERB: Record<BulkChatAction, string> = {
  archive: "Archived",
  unarchive: "Unarchived",
  delete: "Deleted",
};

const FAILED_VERB: Record<BulkChatAction, string> = {
  archive: "archived",
  unarchive: "unarchived",
  delete: "deleted",
};

/**
 * What the batch did, in one line: "Deleted 12 chats." or, when some were
 * refused, "Deleted 10 chats. 2 couldn't be deleted: <first reason>".
 */
export function bulkResultNotice(
  action: BulkChatAction,
  result: PersonalBotThreadsBatchResult,
): { readonly text: string; readonly failed: boolean } {
  const done = result.done.length;
  const failed = result.failed.length;
  const parts: Array<string> = [];
  if (done > 0 || failed === 0) parts.push(`${DONE_VERB[action]} ${chats(done)}.`);
  if (failed > 0) {
    const reason = result.failed[0]?.message.trim().replace(/[.\s]+$/, "") ?? "";
    const count = failed === 1 ? "1 chat" : `${failed} chats`;
    parts.push(
      `${count} couldn't be ${FAILED_VERB[action]}${reason === "" ? "." : `: ${reason}.`}`,
    );
  }
  return { text: parts.join(" "), failed: failed > 0 };
}
