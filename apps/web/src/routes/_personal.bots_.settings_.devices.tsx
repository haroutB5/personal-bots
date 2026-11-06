import { createFileRoute } from "@tanstack/react-router";

import { DevicesScreen } from "~/features/personal/DevicesScreen";

export const Route = createFileRoute("/_personal/bots_/settings_/devices")({
  component: DevicesScreen,
});
