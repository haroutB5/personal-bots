import { createFileRoute } from "@tanstack/react-router";

import { TeamScreen } from "~/features/personal/TeamScreen";

export interface TeamSearch {
  /** The bot whose token usage sheet is open (BotUsageSheet). */
  readonly usage?: string;
}

export const Route = createFileRoute("/_personal/bots_/team")({
  // Optional: the Team screen is also linked to without a search param.
  validateSearch: (raw: Record<string, unknown>): TeamSearch =>
    typeof raw.usage === "string" && raw.usage !== "" ? { usage: raw.usage } : {},
  component: TeamScreen,
});
