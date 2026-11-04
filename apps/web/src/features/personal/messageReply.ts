import { plainTextForQuote, replyQuoteForMessage } from "@hbots/personal-client/feed/messageReply";

export { plainTextForQuote, replyQuoteForMessage };

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
