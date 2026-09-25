import { createFileRoute } from "@tanstack/react-router";

import { GroupConversationScreen } from "~/features/personal/GroupConversationScreen";

export interface GroupSearch {
  /** "members" opens the group's settings on arrival (Back from a member's editor). */
  readonly settings?: "members";
}

function GroupConversationRouteView() {
  const { groupId } = Route.useParams();
  const { settings } = Route.useSearch();
  return (
    <GroupConversationScreen
      key={groupId}
      groupId={groupId}
      openSettings={settings === "members"}
    />
  );
}

export const Route = createFileRoute("/_personal/bots_/groups/$groupId")({
  validateSearch: (raw: Record<string, unknown>): GroupSearch =>
    raw.settings === "members" ? { settings: "members" } : {},
  component: GroupConversationRouteView,
});
