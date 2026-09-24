import { createFileRoute } from "@tanstack/react-router";

import { NewBotScreen } from "~/features/personal/BotForm";
import { parseBotFormSearch } from "~/features/personal/botFormModel";

function NewBotRouteView() {
  const { group } = Route.useSearch();
  return <NewBotScreen intoGroupId={group ?? null} />;
}

export const Route = createFileRoute("/_personal/bots_/new")({
  validateSearch: parseBotFormSearch,
  component: NewBotRouteView,
});
