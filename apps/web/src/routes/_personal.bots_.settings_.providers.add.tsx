import { createFileRoute } from "@tanstack/react-router";

import { AddProviderScreen } from "~/features/personal/providers/AddProviderScreen";

export const Route = createFileRoute("/_personal/bots_/settings_/providers/add")({
  component: AddProviderScreen,
});
