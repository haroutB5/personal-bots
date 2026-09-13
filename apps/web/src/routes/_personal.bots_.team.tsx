import { createFileRoute } from "@tanstack/react-router";

import { TeamScreen } from "~/features/personal/TeamScreen";

export const Route = createFileRoute("/_personal/bots_/team")({
  component: TeamScreen,
});
