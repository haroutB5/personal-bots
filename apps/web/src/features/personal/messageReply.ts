import {
  makePersonalReplyQuote,
  PERSONAL_REPLY_OWNER_NAME,
  type PersonalReplyQuote,
} from "@t3tools/contracts";

import type { ChatMessage } from "~/types";

/**
 * A message's text as plain words, for a quote: the markup a bot writes
 * (emphasis, headings, list markers, links, code fences) would show up as
 * stray symbols in a one-line bar. Light on purpose; the quote is only a
 * reminder of what was said.
 */
export function plainTextForQuote(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, "$1$2");
}

/** The quote a Reply on `message` carries; `name` is who said it (the bot, or "You"). */
export function replyQuoteForMessage(input: {
  readonly message: Pick<ChatMessage, "id" | "role" | "text">;
  readonly botName: string;
}): PersonalReplyQuote {
  return makePersonalReplyQuote({
    messageId: String(input.message.id),
    name: input.message.role === "user" ? PERSONAL_REPLY_OWNER_NAME : input.botName,
    text: plainTextForQuote(input.message.text),
  });
}

/** Marks the element that Reply's jump lands on, long enough to be seen. */
export const REPLY_HIGHLIGHT_ATTRIBUTE = "data-reply-highlight";
export const REPLY_HIGHLIGHT_MS = 1_600;
/** Every replyable message carries its id on this attribute, for the jump. */
export const MESSAGE_ID_ATTRIBUTE = "data-message-id";

/**
 * Scrolls the original of a quote into view and flashes it, when it is loaded
 * in `root`. Returns whether it was found; a quote whose original is not
 * loaded (older than the page, or deleted) does nothing at all.
 */
export function jumpToMessage(root: ParentNode, messageId: string): boolean {
  const target = Array.from(root.querySelectorAll<HTMLElement>(`[${MESSAGE_ID_ATTRIBUTE}]`)).find(
    (element) => element.getAttribute(MESSAGE_ID_ATTRIBUTE) === messageId,
  );
  if (target === undefined) return false;
  // Complete the landing before releasing the transcript's follow guard.
  target.scrollIntoView({ block: "center", behavior: "instant" });
  target.setAttribute(REPLY_HIGHLIGHT_ATTRIBUTE, "");
  window.setTimeout(() => target.removeAttribute(REPLY_HIGHLIGHT_ATTRIBUTE), REPLY_HIGHLIGHT_MS);
  return true;
}
