import { createFileRoute } from "@tanstack/react-router";

import { NewBotScreen } from "~/features/personal/BotForm";

export const Route = createFileRoute("/_personal/bots_/new")({
  component: NewBotScreen,
});
