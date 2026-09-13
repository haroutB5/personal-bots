import { createFileRoute } from "@tanstack/react-router";

import { PersonalSettingsScreen } from "~/features/personal/PersonalSettingsScreen";

export const Route = createFileRoute("/_personal/bots_/settings")({
  component: PersonalSettingsScreen,
});
