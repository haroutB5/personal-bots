import { createFileRoute } from "@tanstack/react-router";

import { ConversationScreen } from "~/features/personal/ConversationScreen";

function ConversationRouteView() {
  const { botId, threadId } = Route.useParams();
  return <ConversationScreen botId={botId} threadId={threadId} />;
}

export const Route = createFileRoute("/_personal/bots_/$botId/$threadId")({
  component: ConversationRouteView,
});
