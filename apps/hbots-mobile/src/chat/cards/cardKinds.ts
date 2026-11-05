import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";

export const CARD_KINDS = ["delegation", "question", "lead-bot-change", "memory-change"] as const;

export type CardKind = (typeof CARD_KINDS)[number];

export type ChatCardItem = Extract<ConversationItem, { readonly kind: CardKind }>;

/** Whether the feed row is one of the registered cards. */
export function isChatCard(item: ConversationItem): item is ChatCardItem {
  return (CARD_KINDS as ReadonlyArray<string>).includes(item.kind);
}
