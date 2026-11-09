import type { ModelSelection } from "@t3tools/contracts";

/**
 * The model selection a bot chat sends with a turn (typed message or Retry).
 * Callers pass the bot's effective selection (`botEffectiveModelSelection`: its
 * fallback model while the usage-limit fallback is active), so a typed message
 */
export function chatTurnModelSelection(
  botModelSelection: ModelSelection | null,
  threadModelSelection: ModelSelection,
): ModelSelection {
  return botModelSelection ?? threadModelSelection;
}
