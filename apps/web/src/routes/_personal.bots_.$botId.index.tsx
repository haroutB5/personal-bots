import { createFileRoute } from "@tanstack/react-router";

import { BotThreadsScreen } from "~/features/personal/BotThreadsScreen";

function BotThreadsRouteView() {
  const { botId } = Route.useParams();
  return <BotThreadsScreen botId={botId} />;
}

export const Route = createFileRoute("/_personal/bots_/$botId/")({
  component: BotThreadsRouteView,
});
