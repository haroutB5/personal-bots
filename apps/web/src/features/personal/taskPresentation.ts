import {
  PERSONAL_TASK_RETRYABLE_STATUSES,
  PERSONAL_TASK_TERMINAL_STATUSES,
  type PersonalRoutine,
  type PersonalTaskStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { PERSONAL_TIME_ZONE } from "./greeting";

export type TaskListFilter = "active" | "waiting" | "scheduled" | "completed";

export const TASK_LIST_FILTERS: ReadonlyArray<{
  readonly id: TaskListFilter;
  readonly label: string;
}> = [
  { id: "active", label: "Active" },
  { id: "waiting", label: "Waiting" },
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
];

export function parseTaskListFilter(value: unknown): TaskListFilter {
  return value === "waiting" || value === "scheduled" || value === "completed" ? value : "active";
}

/** Which list a task belongs to (Scheduled holds routines, not tasks). */
export function taskListFor(status: PersonalTaskStatus): Exclude<TaskListFilter, "scheduled"> {
  switch (status) {
    case "queued":
    case "running":
    case "rate_limited":
      return "active";
    case "waiting_for_agent":
    case "waiting_for_user":
    case "waiting_for_browser":
      return "waiting";
    case "completed":
    case "failed":
    case "interrupted":
    case "cancelled":
      return "completed";
  }
}

const STATUS_LABELS: Record<PersonalTaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  waiting_for_agent: "Waiting on another bot",
  waiting_for_user: "Needs you",
  waiting_for_browser: "Needs the browser",
  rate_limited: "Paused by a rate limit",
  completed: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

export function taskStatusLabel(status: PersonalTaskStatus): string {
  return STATUS_LABELS[status];
}

/** Dot colour: live work green, anything needing attention amber, the rest none. */
export function taskStatusTone(status: PersonalTaskStatus): "live" | "review" | "error" | "none" {
  if (status === "running") return "live";
  if (status === "waiting_for_user" || status === "waiting_for_browser") return "review";
  if (status === "failed") return "error";
  return "none";
}

export function canCancelTask(status: PersonalTaskStatus): boolean {
  return !PERSONAL_TASK_TERMINAL_STATUSES.includes(status);
}

export function canRetryTask(status: PersonalTaskStatus): boolean {
  return PERSONAL_TASK_RETRYABLE_STATUSES.includes(status);
}

/** "Mon 14 Sep, 09:00" in the given zone (Europe/London by default). */
export function formatLocalDateTime(
  instant: Date | number,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  // ICU's en-GB short September is "Sept"; the app writes "Sep".
  const month = pick("month").slice(0, 3);
  return `${pick("weekday")} ${pick("day")} ${month}, ${pick("hour")}:${pick("minute")}`;
}

/**
 * Scheduled routines only: an event routine has no next run. See `routineHook`.
 * Shown in the user's zone like every other time in the app; the routine's own
 * zone decides when it fires, not how the instant reads.
 */
export function routineNextRunLabel(
  routine: Pick<PersonalRoutine, "enabled" | "nextDueAt">,
): string {
  if (!routine.enabled) return "Paused";
  if (routine.nextDueAt === null) return "No more runs";
  return `Next: ${formatLocalDateTime(DateTime.toEpochMillis(routine.nextDueAt))}`;
}
