import { createFileRoute } from "@tanstack/react-router";

import { WorkScreen } from "~/features/personal/WorkScreen";

export const Route = createFileRoute("/_personal/work")({
  component: WorkScreen,
});
