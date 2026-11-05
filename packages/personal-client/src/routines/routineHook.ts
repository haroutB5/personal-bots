import { personalRoutineHookPath, type PersonalRoutine } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatLocalDateTime, routineNextRunLabel } from "../conversation/taskPresentation.ts";

/**
 * The webhook URL to hand to GitHub, Slack, or a home-automation box. The
 * origin is whatever the phone reached the server on, so the caller passes the
 * one it is connected through.
 */
export function routineHookUrl(origin: string, hookToken: string): string {
  return `${origin.replace(/\/+$/, "")}${personalRoutineHookPath(hookToken)}`;
}

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
