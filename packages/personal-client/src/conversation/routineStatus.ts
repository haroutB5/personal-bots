import type { PersonalRoutine } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatLocalDateTime, routineNextRunLabel } from "./taskPresentation.ts";

type RoutineTriggerFields = Pick<PersonalRoutine, "enabled" | "eventLabel" | "lastFiredAt"> &
  Pick<PersonalRoutine, "schedule" | "nextDueAt" | "timeZone">;

/** True for routines that fire on a webhook rather than a clock. */
export function isEventRoutine(routine: Pick<PersonalRoutine, "schedule">): boolean {
  return routine.schedule === null;
}

/**
 * The secondary line under a routine's name. A scheduled routine's is its next
 * run; an event routine has no next run to show and would otherwise read "No
 * more runs", which is the opposite of the truth: it can fire at any moment.
 */
export function routineTriggerStatusLabel(routine: RoutineTriggerFields): string {
  if (!isEventRoutine(routine)) return routineNextRunLabel(routine);
  if (!routine.enabled) return "Paused";
  return routine.lastFiredAt === null
    ? "Waiting for its first event"
    : `Last fired ${formatLocalDateTime(DateTime.toEpochMillis(routine.lastFiredAt))}`;
}
