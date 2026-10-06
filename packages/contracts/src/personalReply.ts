import * as Schema from "effect/Schema";

import { ComposerContextId, type OrchestrationMessageContext } from "./composerContext.ts";

/**
 * "Reply to a message": the quote a reply carries. Rides on the sent message's
 * `context` as a forward-compatible record of this kind, like
 * `PERSONAL_TASK_MESSAGE_CONTEXT_KIND`: the message text stays exactly what the
 * owner typed (previews, titles and notifications never see the quote), the
 * record survives reload with the message, and clients draw the quote above
 * the text. Unlike the task and group markers, providers do get it: the turn
 * input is prefixed with {@link personalReplyModelPrefix}.
 */
export const PERSONAL_REPLY_CONTEXT_KIND = "personal-reply";

/** The most of the quoted message a reply keeps, for the bar, the bubble and the model. */
export const PERSONAL_REPLY_EXCERPT_MAX_CHARS = 300;

/** What the quote calls the owner's own messages (the composer bar and the bubble). */
export const PERSONAL_REPLY_OWNER_NAME = "You";

export const PersonalReplyQuote = Schema.Struct({
  /** The quoted message, for the jump. Only matches while that message is loaded. */
  messageId: Schema.String,
  /** Who said it: a bot's name, or {@link PERSONAL_REPLY_OWNER_NAME}. */
  name: Schema.String,
  /** The quoted text, whitespace collapsed, at most {@link PERSONAL_REPLY_EXCERPT_MAX_CHARS} characters. */
  excerpt: Schema.String,
});
export type PersonalReplyQuote = typeof PersonalReplyQuote.Type;

/** Whitespace collapsed to single spaces, cut at the cap with an ellipsis. */
export function personalReplyExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= PERSONAL_REPLY_EXCERPT_MAX_CHARS) return flat;
  return `${flat.slice(0, PERSONAL_REPLY_EXCERPT_MAX_CHARS - 1).trimEnd()}…`;
}

export function makePersonalReplyQuote(input: {
  readonly messageId: string;
  readonly name: string;
  readonly text: string;
}): PersonalReplyQuote {
  return {
    messageId: input.messageId,
    name: input.name.trim().slice(0, 80) || "Bot",
    excerpt: personalReplyExcerpt(input.text),
  };
}

/** The message `context` that carries a quote: one forward-compatible record. */
export function personalReplyContext(quote: PersonalReplyQuote): OrchestrationMessageContext {
  return {
    version: 1,
    records: [
      {
        version: 1,
        contextId: ComposerContextId.make(PERSONAL_REPLY_CONTEXT_KIND),
        label: `Reply to ${quote.name}`,
        kind: PERSONAL_REPLY_CONTEXT_KIND,
        payload: quote,
      },
    ],
  };
}

/** The quote a message's `context` carries, or null (none, or not shaped like one). */
export function readPersonalReplyQuote(
  context: { readonly records: ReadonlyArray<object> } | null | undefined,
): PersonalReplyQuote | null {
  if (context === null || context === undefined) return null;
  for (const record of context.records) {
    const entry = record as { readonly kind?: unknown; readonly payload?: unknown };
    if (entry.kind !== PERSONAL_REPLY_CONTEXT_KIND) continue;
    const payload = entry.payload as Partial<PersonalReplyQuote> | null | undefined;
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.messageId !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.excerpt !== "string" ||
      payload.excerpt.length === 0
    ) {
      return null;
    }
    return {
      messageId: payload.messageId,
      name: payload.name,
      // Whatever was stored, never more than the cap reaches a model or a bubble.
      excerpt: personalReplyExcerpt(payload.excerpt),
    };
  }
  return null;
}

/**
 * How a model reads a quote: a short bracketed line in front of the message,
 * `[Replying to Mori's earlier message: "..."]`. The owner's own earlier
 * message reads "my earlier message", since the owner is the one speaking.
 */
export function personalReplyModelPrefix(quote: PersonalReplyQuote): string {
  const whose =
    quote.name === PERSONAL_REPLY_OWNER_NAME
      ? "my earlier message"
      : `${quote.name}'s earlier message`;
  return `[Replying to ${whose}: "${quote.excerpt.replaceAll('"', "'")}"]`;
}

/** The turn text a provider gets: the quote line, a blank line, then what was typed. */
export function withPersonalReplyQuote(
  text: string,
  context: { readonly records: ReadonlyArray<object> } | null | undefined,
): string {
  const quote = readPersonalReplyQuote(context);
  return quote === null ? text : `${personalReplyModelPrefix(quote)}\n\n${text}`;
}
