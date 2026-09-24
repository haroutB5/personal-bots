import { createFileRoute } from "@tanstack/react-router";

import { EditBotScreen } from "~/features/personal/BotForm";

interface BotFormSearch {
  /** Opened from this group's settings; the editor returns there. */
  readonly group?: string;
}

// Inline, not imported from botFormModel: this file is in the eager route
// tree, and an import would split botFormModel into a chunk of its own that
// every page load fetches.
const parseBotFormSearch = (raw: Record<string, unknown>): BotFormSearch =>
  typeof raw.group === "string" && raw.group.trim().length > 0 ? { group: raw.group } : {};

function EditBotRouteView() {
  const { botId } = Route.useParams();
  const { group } = Route.useSearch();
  return <EditBotScreen botId={botId} fromGroupId={group ?? null} />;
}

export const Route = createFileRoute("/_personal/bots_/$botId/edit")({
  validateSearch: parseBotFormSearch,
  component: EditBotRouteView,
});
