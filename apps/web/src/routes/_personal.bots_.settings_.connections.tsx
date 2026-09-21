import { createFileRoute } from "@tanstack/react-router";

import { PersonalConnectionsScreen } from "~/features/personal/PersonalConnectionsScreen";

export const Route = createFileRoute("/_personal/bots_/settings_/connections")({
  component: PersonalConnectionsScreen,
});
