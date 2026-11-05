import type { ConversationItem } from "@hbots/personal-client/conversation/conversationModel";
import { turnStartByAssistantItem } from "@hbots/personal-client/feed/contextUsed";

/**
 * The user message that started the last reply's turn: what "Context used"
 * reads for. Null when the chat has no reply yet.
 */
export function lastTurnStartMessageId(items: ReadonlyArray<ConversationItem>): string | null {
  const starters = turnStartByAssistantItem(items);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "message" && item.message.role === "assistant") {
      return starters.get(item.id) ?? null;
    }
  }
  return null;
}
