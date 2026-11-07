import type { PersonalLoginRequest } from "@t3tools/contracts";

import {
  placeConnectionApprovalCards,
  placeLeadBotChangeCards,
  placeLoginRequestCards,
  placeMemoryCards,
  placeQuestionCards,
  placeSecretRequestCards,
  type ConversationItem,
} from "./conversationModel.ts";
import type { ConnectionApprovalCardItem } from "./connectionApprovalCards.ts";
import type { LeadBotChangeCardItem } from "./leadBotChangeCards.ts";
import type { MemoryCardItem } from "./memoryCards.ts";
import type { QuestionCardItem } from "./questionCards.ts";
import type { SecretRequestCardItem } from "./secretRequestCards.ts";

/**
 * Every card source for one chat. A source with nothing to show is an empty
 * list, so a screen that has not built a card kind yet still renders the feed.
 */
export interface ChatCardSources {
  readonly questions: ReadonlyArray<QuestionCardItem>;
  readonly secrets: ReadonlyArray<SecretRequestCardItem>;
  readonly logins: ReadonlyArray<PersonalLoginRequest>;
  readonly connectionApprovals: ReadonlyArray<ConnectionApprovalCardItem>;
  readonly leadBotChanges: ReadonlyArray<LeadBotChangeCardItem>;
  readonly memoryChanges: ReadonlyArray<MemoryCardItem>;
}

export const NO_CHAT_CARDS: ChatCardSources = {
  questions: [],
  secrets: [],
  logins: [],
  connectionApprovals: [],
  leadBotChanges: [],
  memoryChanges: [],
};

/**
 * Places every card in the chat at the moment it happened, open ones last.
 * The nesting order changes nothing: each placement only inserts, never
 * reorders what is already there.
 */
export function placeChatCards(
  items: ReadonlyArray<ConversationItem>,
  sources: ChatCardSources,
): ConversationItem[] {
  return placeMemoryCards(
    placeLeadBotChangeCards(
      placeConnectionApprovalCards(
        placeLoginRequestCards(
          placeSecretRequestCards(placeQuestionCards(items, sources.questions), sources.secrets),
          sources.logins,
        ),
        sources.connectionApprovals,
      ),
      sources.leadBotChanges,
    ),
    sources.memoryChanges,
  );
}
