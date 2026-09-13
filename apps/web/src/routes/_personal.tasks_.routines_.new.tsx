import { createFileRoute } from "@tanstack/react-router";

import { RoutineForm } from "~/features/personal/RoutineForm";

function NewRoutineRouteView() {
  return <RoutineForm routine={null} />;
}

export const Route = createFileRoute("/_personal/tasks_/routines_/new")({
  component: NewRoutineRouteView,
});
