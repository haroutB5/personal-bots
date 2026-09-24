import { createFileRoute } from "@tanstack/react-router";

import { EditBotScreen } from "~/features/personal/BotForm";
import { parseBotFormSearch } from "~/features/personal/botFormModel";

function EditBotRouteView() {
  const { botId } = Route.useParams();
  const { group } = Route.useSearch();
  return <EditBotScreen botId={botId} fromGroupId={group ?? null} />;
}

export const Route = createFileRoute("/_personal/bots_/$botId/edit")({
  validateSearch: parseBotFormSearch,
  component: EditBotRouteView,
});
