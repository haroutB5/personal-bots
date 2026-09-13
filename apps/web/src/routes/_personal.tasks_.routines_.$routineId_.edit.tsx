import { createFileRoute } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";

import { RoutineForm } from "~/features/personal/RoutineForm";
import { usePersonalRoutines } from "~/features/personal/usePersonalAutomation";
import { usePersonalEnvironmentId } from "~/features/personal/usePersonalBots";

function EditRoutineRouteView() {
  const { routineId } = Route.useParams();
  const routines = usePersonalRoutines(usePersonalEnvironmentId());
  const routine = routines.data?.routines.find((entry) => entry.routineId === routineId);
  if (routine === undefined) {
    return (
      <p className="px-5 pt-16 text-[15px] text-[var(--personal-text-secondary)]">
        {routines.data === null ? "Loading..." : "This routine was not found."}
      </p>
    );
  }
  // Keyed so the form re-initialises if the routine changes underneath it.
  return (
    <RoutineForm
      key={`${routine.routineId}:${DateTime.formatIso(routine.updatedAt)}`}
      routine={routine}
    />
  );
}

export const Route = createFileRoute("/_personal/tasks_/routines_/$routineId_/edit")({
  component: EditRoutineRouteView,
});
