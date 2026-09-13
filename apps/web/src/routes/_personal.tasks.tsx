import { createFileRoute } from "@tanstack/react-router";
import { CircleCheck } from "lucide-react";

import { PersonalEmptyTab } from "~/features/personal/PersonalEmptyTab";

function TasksRouteView() {
  return (
    <PersonalEmptyTab
      title="Tasks"
      heading="No tasks yet"
      description="Routines and scheduled work from your bots will show up here."
      icon={CircleCheck}
    />
  );
}

export const Route = createFileRoute("/_personal/tasks")({
  component: TasksRouteView,
});
