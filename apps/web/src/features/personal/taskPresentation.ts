import {
  PERSONAL_TASK_RETRYABLE_STATUSES,
  PERSONAL_TASK_TERMINAL_STATUSES,
  type PersonalRoutine,
  type PersonalTask,
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
  // "Done", not "Completed": four segments share a 350px phone row, and the
  // long word truncated to "Complet…" beside its count.
  { id: "completed", label: "Done" },
];

/**
 * Every tab shows its count (owner's call: the row should read at a glance,
 * zero included). Only work in flight and work waiting on someone is drawn
 * at full strength when non-zero; Done (100+) and Scheduled stay muted so a
 * big number there doesn't read as something needing attention.
 */
export function taskListCountNeedsAttention(filter: TaskListFilter): boolean {
  return filter === "active" || filter === "waiting";
}

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

/**
 * The confirm shown before Stop task. Stopping abandons in-flight work
 * (delegations included) and Retry starts over rather than resuming, so it is
 * a destructive action and says so.
 */
export function stopTaskConfirmMessage(title: string): string {
  const name = title.trim().length > 0 ? title.trim() : "this task";
  return `Stop ${name}?
The bot stops now; work in progress is lost.`;
}

export function canRetryTask(status: PersonalTaskStatus): boolean {
  return PERSONAL_TASK_RETRYABLE_STATUSES.includes(status);
}

const localDateTimeFormats = new Map<string, Intl.DateTimeFormat>();
/**
 * One formatter per zone: building an Intl.DateTimeFormat costs far more than
 * using one, and the Bots list formats a routine's next run for every bot on
 * every rebuild (1.64.1: 1% of the phone's main thread while bots streamed).
 */
function localDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  let format = localDateTimeFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    localDateTimeFormats.set(timeZone, format);
  }
  return format;
}

interface LocalDateTimeParts {
  /** The calendar day in the zone, "2026-10-17"; equal strings are the same day. */
  readonly dayKey: string;
  readonly weekday: string;
  readonly day: string;
  readonly month: string;
  readonly hour: string;
  readonly minute: string;
}

function localDateTimeParts(instant: Date | number, timeZone: string): LocalDateTimeParts {
  const parts = localDateTimeFormat(timeZone).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const year = pick("year");
  const day = pick("day");
  const monthText = pick("month");
  return {
    dayKey: `${year}-${monthText}-${day}`,
    weekday: pick("weekday"),
    day,
    // ICU's en-GB short September is "Sept"; the app writes "Sep".
    month: monthText.slice(0, 3),
    hour: pick("hour"),
    minute: pick("minute"),
  };
}

/** "Mon 14 Sep, 09:00" in the given zone (Europe/London by default). */
export function formatLocalDateTime(
  instant: Date | number,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const parts = localDateTimeParts(instant, timeZone);
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/**
 * A routine's next run: "Today, 14:30" when it falls on the calendar day it is
 * read on in London, else the usual "Sat 17 Oct, 14:30". Same-day, not within
 * 24 hours: a run at 00:20 tomorrow is not "Today" at 23:50.
 */
function formatNextRunDateTime(
  instant: Date | number,
  now: Date | number,
  timeZone: string,
): string {
  const parts = localDateTimeParts(instant, timeZone);
  if (parts.dayKey === localDateTimeParts(now, timeZone).dayKey) {
    return `Today, ${parts.hour}:${parts.minute}`;
  }
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/**
 * Scheduled routines only: an event routine has no next run. See `routineHook`.
 * Shown in the user's zone like every other time in the app; the routine's own
 * zone decides when it fires, not how the instant reads. A run on today's
 * London date reads "Today, HH:MM" ("Next: Today, 14:30"); any other day keeps
 * the weekday ("Next: Sat 17 Oct, 14:30").
 */
export function routineNextRunLabel(
  routine: Pick<PersonalRoutine, "enabled" | "nextDueAt">,
  now: Date | number = Date.now(),
): string {
  if (!routine.enabled) return "Paused";
  if (routine.nextDueAt === null) return "No more runs";
  const nextRun = formatNextRunDateTime(
    DateTime.toEpochMillis(routine.nextDueAt),
    now,
    PERSONAL_TIME_ZONE,
  );
  return `Next: ${nextRun}`;
}

/**
 * The feed with `extra` tasks folded in; for a task in both, the newer copy
 * wins (the feed is live, a query result can be older or newer than it).
 */
export function mergeTaskLists(
  feed: ReadonlyMap<string, PersonalTask> | null,
  extra: ReadonlyArray<PersonalTask> | null | undefined,
): ReadonlyMap<string, PersonalTask> | null {
  if (feed === null || extra === null || extra === undefined || extra.length === 0) return feed;
  const merged = new Map(feed);
  for (const task of extra) {
    const current = merged.get(task.taskId);
    if (
      current === undefined ||
      DateTime.toEpochMillis(task.updatedAt) > DateTime.toEpochMillis(current.updatedAt)
    ) {
      merged.set(task.taskId, task);
    }
  }
  return merged;
}
