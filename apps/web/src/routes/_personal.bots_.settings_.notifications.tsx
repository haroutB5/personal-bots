import { createFileRoute } from "@tanstack/react-router";

import { NotificationsScreen } from "~/features/personal/NotificationsScreen";

export const Route = createFileRoute("/_personal/bots_/settings_/notifications")({
  component: NotificationsScreen,
});
