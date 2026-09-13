import { createFileRoute } from "@tanstack/react-router";

import { EditBotScreen } from "~/features/personal/BotForm";

function EditBotRouteView() {
  const { botId } = Route.useParams();
  return <EditBotScreen botId={botId} />;
}

export const Route = createFileRoute("/_personal/bots_/$botId/edit")({
  component: EditBotRouteView,
});
