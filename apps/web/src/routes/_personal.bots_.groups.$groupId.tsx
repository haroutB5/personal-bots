import { createFileRoute } from "@tanstack/react-router";

import { GroupConversationScreen } from "~/features/personal/GroupConversationScreen";

function GroupConversationRouteView() {
  const { groupId } = Route.useParams();
  return <GroupConversationScreen groupId={groupId} />;
}

export const Route = createFileRoute("/_personal/bots_/groups/$groupId")({
  component: GroupConversationRouteView,
});
