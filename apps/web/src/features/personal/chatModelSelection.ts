import type { ModelSelection } from "@t3tools/contracts";

/**
 * The model selection a bot chat sends with a turn (typed message or Retry).
 * The bot's own selection wins whatever provider it is on: the server moves
 * the chat to the bot's provider on its next turn. The thread's selection is
 * only the fallback while the bot is not known yet, because a copy of it that
 * is older than a provider switch is refused by the server as "bound to
 * driver" (a phone backgrounded across the move still holds the old one).
 */
export function chatTurnModelSelection(
  botModelSelection: ModelSelection | null,
  threadModelSelection: ModelSelection,
): ModelSelection {
  return botModelSelection ?? threadModelSelection;
}
