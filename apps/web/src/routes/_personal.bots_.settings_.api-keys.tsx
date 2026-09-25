import { createFileRoute } from "@tanstack/react-router";

import { ApiKeysScreen } from "~/features/personal/ApiKeysScreen";

export const Route = createFileRoute("/_personal/bots_/settings_/api-keys")({
  component: ApiKeysScreen,
});
