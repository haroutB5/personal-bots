import { createFileRoute } from "@tanstack/react-router";

import { RemovedBotsScreen } from "~/features/personal/RemovedBotsScreen";

export const Route = createFileRoute("/_personal/bots_/settings_/removed")({
  component: RemovedBotsScreen,
});
