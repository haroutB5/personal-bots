import { createFileRoute } from "@tanstack/react-router";

import { NewGroupScreen } from "~/features/personal/NewGroupScreen";

export const Route = createFileRoute("/_personal/bots_/groups/new")({
  component: NewGroupScreen,
});
