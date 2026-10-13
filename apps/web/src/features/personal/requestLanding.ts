import type { ConversationItem } from "./conversationModel";

/** The wash the landing card takes (SPEC 2.9, M2): held 200 ms, faded over 1200. */
export const REQUEST_WASH_ATTRIBUTE = "data-request-wash";
export const REQUEST_WASH_MS = 1_400;

/** The item-id prefixes that carry a request (conversationModel's placement helpers). */
const REQUEST_ITEM_PREFIXES = [
  "question",
  "secret",
  "login",
  "connection-approval",
  "lead-bot-change",
  "memory-change",
] as const;

/** Whether this transcript item is an open request: something the owner has to answer. */
export function isPendingRequestItem(item: ConversationItem): boolean {
  switch (item.kind) {
    case "secret":
    case "connection-approval":
    case "lead-bot-change":
      return item.card.kind === "pending";
    case "memory-change":
      return item.card.pending;
    case "login":
      return (item.request as { readonly status?: string }).status === "pending";
    default:
      return false;
  }
}

/** The transcript item carrying a specific request, or null when it is not in the chat. */
export function findRequestItemId(
  items: ReadonlyArray<ConversationItem>,
  requestId: string,
): string | null {
  for (const item of items) {
    for (const prefix of REQUEST_ITEM_PREFIXES) {
      if (item.id === `${prefix}:${requestId}`) return item.id;
    }
  }
  return null;
}

/**
 * What a chat opened at its own request lands on (D13), with no `?request=` to
 * name it: the newest open request card still in the thread. The open question
 * and the pending approval are deliberately not candidates - the question is
 * docked above the composer and the approval is pinned under the transcript,
 * so both are on screen wherever the thread is.
 */
export function openRequestLandingItemId(items: ReadonlyArray<ConversationItem>): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || item.kind === "question") continue;
    if (isPendingRequestItem(item)) return item.id;
  }
  return null;
}
