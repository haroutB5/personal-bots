import { createFileRoute } from "@tanstack/react-router";

import { PasswordsScreen } from "~/features/personal/PasswordsScreen";

export const Route = createFileRoute("/_personal/bots_/settings_/passwords")({
  component: PasswordsScreen,
});
