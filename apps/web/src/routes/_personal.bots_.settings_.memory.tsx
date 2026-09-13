import { createFileRoute } from "@tanstack/react-router";

import { MemoryScreen } from "~/features/personal/MemoryScreen";

export const Route = createFileRoute("/_personal/bots_/settings_/memory")({
  component: MemoryScreen,
});
