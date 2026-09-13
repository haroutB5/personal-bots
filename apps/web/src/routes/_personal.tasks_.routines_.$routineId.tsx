import { PersonalRoutineId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { RoutineDetailScreen } from "~/features/personal/RoutineDetailScreen";

function RoutineDetailRouteView() {
  const { routineId } = Route.useParams();
  return <RoutineDetailScreen key={routineId} routineId={PersonalRoutineId.make(routineId)} />;
}

export const Route = createFileRoute("/_personal/tasks_/routines_/$routineId")({
  component: RoutineDetailRouteView,
});
