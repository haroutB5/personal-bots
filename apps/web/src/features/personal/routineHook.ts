import { personalRoutineHookPath, type PersonalRoutine } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatLocalDateTime, routineNextRunLabel } from "./taskPresentation";

/**
 * The webhook URL to hand to GitHub, Slack, or a home-automation box.
 *
 * The origin is whatever the phone reached the server on — the T3 Connect
 * tunnel hostname when the phone is out of the house, the LAN address when it
 * is not. The server never knows which one the user wants pasted into a
 * third-party dashboard, and only the tunnel one is reachable from the
 * internet, so the URL is built from the origin the page is actually served
 * from rather than from anything the server reports.
 */
export function routineHookUrl(origin: string, hookToken: string): string {
  return `${origin.replace(/\/+$/, "")}${personalRoutineHookPath(hookToken)}`;
}

/** The origin the client is served from, or null when there is no document. */
export function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
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
 * more runs", which is the opposite of the truth — it can fire at any moment.
 */
export function routineTriggerStatusLabel(routine: RoutineTriggerFields): string {
  if (!isEventRoutine(routine)) return routineNextRunLabel(routine);
  if (!routine.enabled) return "Paused";
  return routine.lastFiredAt === null
    ? "Waiting for its first event"
    : `Last fired ${formatLocalDateTime(DateTime.toEpochMillis(routine.lastFiredAt), routine.timeZone)}`;
}
