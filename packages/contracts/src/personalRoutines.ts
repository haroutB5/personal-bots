import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId } from "./personalBots.ts";
import { PersonalTask, PersonalTaskId } from "./personalTasks.ts";

export const PersonalRoutineId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalRoutineId"));
export type PersonalRoutineId = typeof PersonalRoutineId.Type;

/** `HH:MM`, 24-hour local wall time. */
export const PersonalLocalTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));
/** `YYYY-MM-DDTHH:MM`, naive local date-time in the routine's zone. */
export const PersonalLocalDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/),
);
/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export const PersonalIsoWeekday = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 }));

export const PersonalRoutineSchedule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("daily"), time: PersonalLocalTime }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    days: Schema.Array(PersonalIsoWeekday).check(Schema.isMinLength(1)),
    time: PersonalLocalTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("interval"),
    everyHours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 168 })),
    /** UTC instant the interval counts from; the server sets it on create when omitted. */
    anchorAt: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("once"), at: PersonalLocalDateTime }),
]);
export type PersonalRoutineSchedule = typeof PersonalRoutineSchedule.Type;

/** coalesce: one catch-up run for the latest missed slot. skip: none. */
export const PersonalRoutineMissedPolicy = Schema.Literals(["coalesce", "skip"]);
export type PersonalRoutineMissedPolicy = typeof PersonalRoutineMissedPolicy.Type;

export const PERSONAL_ROUTINE_DEFAULT_TIME_ZONE = "Europe/London";

export const PersonalRoutine = Schema.Struct({
  routineId: PersonalRoutineId,
  botId: PersonalBotId,
  title: Schema.String,
  prompt: Schema.String,
  schedule: PersonalRoutineSchedule,
  timeZone: Schema.String,
  enabled: Schema.Boolean,
  missedPolicy: PersonalRoutineMissedPolicy,
  /** Null once a one-off has run. */
  nextDueAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  lastOccurrenceLocal: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalRoutine = typeof PersonalRoutine.Type;

export const PersonalRoutineOccurrenceStatus = Schema.Literals(["created", "skipped", "failed"]);
export type PersonalRoutineOccurrenceStatus = typeof PersonalRoutineOccurrenceStatus.Type;

export const PersonalRoutineOccurrence = Schema.Struct({
  routineId: PersonalRoutineId,
  /** Nominal local slot (`YYYY-MM-DDTHH:MM`), or `manual:<id>` for Run now. */
  localOccurrence: Schema.String,
  dueAt: Schema.DateTimeUtcFromString,
  taskId: Schema.NullOr(PersonalTaskId),
  status: PersonalRoutineOccurrenceStatus,
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
});
export type PersonalRoutineOccurrence = typeof PersonalRoutineOccurrence.Type;

export const PersonalRoutineCreateInput = Schema.Struct({
  /** Client-generated; creating twice with one id returns the first routine. */
  routineId: PersonalRoutineId,
  botId: PersonalBotId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  schedule: PersonalRoutineSchedule,
  timeZone: Schema.optional(TrimmedNonEmptyString),
  missedPolicy: Schema.optional(PersonalRoutineMissedPolicy),
});
export type PersonalRoutineCreateInput = typeof PersonalRoutineCreateInput.Type;

export const PersonalRoutineUpdateInput = Schema.Struct({
  routineId: PersonalRoutineId,
  botId: Schema.optional(PersonalBotId),
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  schedule: Schema.optional(PersonalRoutineSchedule),
  timeZone: Schema.optional(TrimmedNonEmptyString),
  missedPolicy: Schema.optional(PersonalRoutineMissedPolicy),
});
export type PersonalRoutineUpdateInput = typeof PersonalRoutineUpdateInput.Type;

export const PersonalRoutineIdInput = Schema.Struct({ routineId: PersonalRoutineId });
export type PersonalRoutineIdInput = typeof PersonalRoutineIdInput.Type;

export const PersonalRoutineRunNowInput = Schema.Struct({
  routineId: PersonalRoutineId,
  /** Client-generated; a retried Run now with the same id starts one task. */
  requestId: Schema.optional(TrimmedNonEmptyString),
});
export type PersonalRoutineRunNowInput = typeof PersonalRoutineRunNowInput.Type;

export const PersonalRoutineListResult = Schema.Struct({
  routines: Schema.Array(PersonalRoutine),
  /** The most recent occurrences, newest first, at most 10 per routine. */
  occurrences: Schema.Array(PersonalRoutineOccurrence),
});
export type PersonalRoutineListResult = typeof PersonalRoutineListResult.Type;

export const PersonalRoutineRunNowResult = Schema.Struct({
  routine: PersonalRoutine,
  task: PersonalTask,
});
export type PersonalRoutineRunNowResult = typeof PersonalRoutineRunNowResult.Type;

export class PersonalRoutinesError extends Schema.TaggedError<PersonalRoutinesError>()(
  "PersonalRoutinesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Human summary of a schedule, e.g. "Weekdays at 09:00 (Europe/London)". */
export function describePersonalRoutineSchedule(
  schedule: PersonalRoutineSchedule,
  timeZone: string,
): string {
  switch (schedule.kind) {
    case "daily":
      return `Every day at ${schedule.time} (${timeZone})`;
    case "weekly": {
      const days = [...new Set(schedule.days)].toSorted((left, right) => left - right);
      const label =
        days.length === 7
          ? "Every day"
          : days.join(",") === "1,2,3,4,5"
            ? "Weekdays"
            : days.join(",") === "6,7"
              ? "Weekends"
              : `Every ${days.map((day) => WEEKDAY_NAMES[day - 1]).join(", ")}`;
      return `${label} at ${schedule.time} (${timeZone})`;
    }
    case "interval":
      return schedule.everyHours === 1 ? "Every hour" : `Every ${schedule.everyHours} hours`;
    case "once":
      return `Once on ${schedule.at.slice(0, 10)} at ${schedule.at.slice(11)} (${timeZone})`;
  }
}
