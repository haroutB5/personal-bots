import { quoteThirdPartyText, standingRuleFor } from "../thirdPartyText.ts";

/**
 * What comes back out of someone else's WhatsApp message.
 *
 * Unlike a business API, anyone who has the owner's number can write into
 * this channel, and a full-access bot reads it. So a message the owner
 * received is never handed over as plain text that could read as a turn of
 * conversation: each one is quoted, labelled with who wrote it, and carried
 * under a standing rule that says instructions inside it are not the owner's
 * instructions. That is why `read_chat` is a separate operation a bot has to
 * ask for rather than a feed pushed into its context.
 */

export const INBOUND_STANDING_RULE = standingRuleFor("the owner's WhatsApp");

export interface InboundMessage {
  readonly author: string;
  readonly fromOwner: boolean;
  readonly sentAtIso: string;
  readonly text: string;
}

export interface WrappedMessage {
  readonly author: string;
  readonly fromOwner: boolean;
  /** "the owner" or "third party", so the label survives any re-rendering. */
  readonly source: string;
  readonly sentAtIso: string;
  readonly quotedText: string;
}

export interface WrappedConversation {
  readonly chat: string;
  readonly standingRule: string;
  readonly messages: ReadonlyArray<WrappedMessage>;
}

export function wrapInboundMessages(input: {
  readonly chatDisplayName: string;
  readonly messages: ReadonlyArray<InboundMessage>;
}): WrappedConversation {
  return {
    chat: input.chatDisplayName,
    standingRule: INBOUND_STANDING_RULE,
    messages: input.messages.map((message) => ({
      author: message.author,
      fromOwner: message.fromOwner,
      source: message.fromOwner ? "the owner" : "third party",
      sentAtIso: message.sentAtIso,
      quotedText: quoteThirdPartyText(message.text),
    })),
  };
}
