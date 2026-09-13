import { createFileRoute } from "@tanstack/react-router";

import { ChatsScreen } from "~/features/personal/ChatsScreen";

export const Route = createFileRoute("/_personal/bots")({
  component: ChatsScreen,
});
