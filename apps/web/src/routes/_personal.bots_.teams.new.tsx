import { createFileRoute } from "@tanstack/react-router";

import { NewTeamScreen } from "~/features/personal/NewTeamScreen";

export const Route = createFileRoute("/_personal/bots_/teams/new")({
  component: NewTeamScreen,
});
