import {
  makePersonalReplyQuote,
  PERSONAL_REPLY_OWNER_NAME,
  type PersonalReplyQuote,
} from "@t3tools/contracts";

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
  readonly message: { readonly id: string; readonly role: string; readonly text: string };
  readonly botName: string;
}): PersonalReplyQuote {
  return makePersonalReplyQuote({
    messageId: String(input.message.id),
    name: input.message.role === "user" ? PERSONAL_REPLY_OWNER_NAME : input.botName,
    text: plainTextForQuote(input.message.text),
  });
}
