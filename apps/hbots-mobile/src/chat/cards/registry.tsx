import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";
import type { ReactElement } from "react";

import { CARD_KINDS, isChatCard, type CardKind, type ChatCardItem } from "./cardKinds";
import { DelegationCard } from "./DelegationCard";
import { LeadBotChangeCard } from "./LeadBotChangeCard";
import { MemoryChangeCard } from "./MemoryChangeCard";
import { QuestionCard } from "./QuestionCard";
import type { CardContext } from "./types";

type Renderers = {
  readonly [K in CardKind]: (
    item: Extract<ConversationItem, { readonly kind: K }>,
    context: CardContext,
  ) => ReactElement | null;
};

/**
 * One entry per card kind: adding a card means adding a line here. The record
 * type makes a missing kind a compile error, so a feed row can never land in
 * the registry and render nothing.
 */
const CARD_REGISTRY: Renderers = {
  delegation: (item, context) => <DelegationCard task={item.task} context={context} />,
  question: (item, context) => <QuestionCard card={item.card} context={context} />,
  "lead-bot-change": (item, context) => <LeadBotChangeCard card={item.card} context={context} />,
  "memory-change": (item, context) => <MemoryChangeCard item={item.card} context={context} />,
};

export { CARD_KINDS, isChatCard };
export type { CardKind, ChatCardItem };

export function renderChatCard(item: ChatCardItem, context: CardContext): ReactElement | null {
  switch (item.kind) {
    case "delegation":
      return CARD_REGISTRY.delegation(item, context);
    case "question":
      return CARD_REGISTRY.question(item, context);
    case "lead-bot-change":
      return CARD_REGISTRY["lead-bot-change"](item, context);
    case "memory-change":
      return CARD_REGISTRY["memory-change"](item, context);
  }
}
