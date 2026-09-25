import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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

/**
 * What starts a run. `schedule` routines have a schedule and a next-due time;
 * `event` routines have neither and fire when their webhook is called. The
 * trigger is fixed at creation: an event routine has no schedule to fall back
 * to, and a scheduled routine has no hook token, so flipping one would have to
 * invent the other silently.
 */
export const PersonalRoutineTrigger = Schema.Literals(["schedule", "event"]);
export type PersonalRoutineTrigger = typeof PersonalRoutineTrigger.Type;

/**
 * How a run reaches the user. `model`: the bot gets the prompt as a task and
 * replies. `relay`: no model turn; the text is posted into a new chat of the
 * bot as its own message and the run completes at once. A scheduled relay
 * posts the routine's prompt; an event relay posts the payload's `message`
 * field (see {@link personalRoutineRelayMessage}).
 */
export const PersonalRoutineDelivery = Schema.Literals(["model", "relay"]);
export type PersonalRoutineDelivery = typeof PersonalRoutineDelivery.Type;

const decodeRelayJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** A relayed message longer than this is cut, with a note saying so. */
export const PERSONAL_ROUTINE_RELAY_MAX_CHARS = 8_000;

/**
 * The text an event relay posts: the payload's top-level `message` string,
 * from a JSON or form body. Null when there is none, and the run then fails
 * rather than post an arbitrary body as the bot's words.
 */
export function personalRoutineRelayMessage(
  contentType: string | null,
  body: string,
): string | null {
  const mediaType = (contentType ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  let message: unknown = null;
  if (mediaType === "application/x-www-form-urlencoded") {
    message = new URLSearchParams(body).get("message");
  } else {
    const parsed = Option.getOrNull(decodeRelayJson(body));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      message = (parsed as Record<string, unknown>).message;
    }
  }
  if (typeof message !== "string" || message.trim().length === 0) return null;
  return message.length > PERSONAL_ROUTINE_RELAY_MAX_CHARS
    ? `${message.slice(0, PERSONAL_ROUTINE_RELAY_MAX_CHARS)}\n\n(message cut at ${PERSONAL_ROUTINE_RELAY_MAX_CHARS} of ${message.length} characters)`
    : message;
}

/** Path prefix of the unauthenticated webhook endpoint: `<prefix>/<hookToken>`. */
export const PERSONAL_ROUTINE_HOOK_ROUTE_PREFIX = "/api/personal/hooks";

/** 32 random bytes, base64url, no padding. */
export const PERSONAL_ROUTINE_HOOK_TOKEN_BYTES = 32;
export const PERSONAL_ROUTINE_HOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Largest webhook body accepted; anything above is rejected, never queued. */
export const PERSONAL_ROUTINE_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;
/** How much of the payload reaches the bot's prompt. */
export const PERSONAL_ROUTINE_EVENT_PAYLOAD_PROMPT_CHARS = 4_000;
/** One fire per token per window; excess is dropped with 429, not queued. */
export const PERSONAL_ROUTINE_EVENT_MIN_INTERVAL_MS = 30_000;

/** `<prefix>/<token>`; join with the origin the phone reached the server on. */
export function personalRoutineHookPath(hookToken: string): string {
  return `${PERSONAL_ROUTINE_HOOK_ROUTE_PREFIX}/${hookToken}`;
}

export const PersonalRoutine = Schema.Struct({
  routineId: PersonalRoutineId,
  botId: PersonalBotId,
  title: Schema.String,
  prompt: Schema.String,
  trigger: PersonalRoutineTrigger,
  /** Null for event routines, which have no schedule at all. */
  schedule: Schema.NullOr(PersonalRoutineSchedule),
  /** Event routines only: the user-facing name of the event, e.g. "PR merged". */
  eventLabel: Schema.NullOr(Schema.String),
  /** Event routines only: the secret in the webhook URL. */
  hookToken: Schema.NullOr(Schema.String),
  /** Event routines only: when the webhook last started a run. */
  lastFiredAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  timeZone: Schema.String,
  enabled: Schema.Boolean,
  missedPolicy: PersonalRoutineMissedPolicy,
  /**
   * Optional on the wire so a client that updated before the server still
   * decodes an older list; the server always sends it. Absent means `model`.
   */
  delivery: Schema.optionalKey(PersonalRoutineDelivery),
  /**
   * The chat the routine was created from (a bot's create_routine call). Each
   * model run is posted into it as a new turn, waiting for the chat to be idle,
   * unless `newChatEachRun` is set or the chat is gone, archived or no longer
   * the routine's bot's; then the run opens a new chat. Null for routines made
   * on the Scheduled screen. Optional on the wire like `delivery`.
   */
  threadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
  /** True: every run opens a new chat even though the routine has a source chat. */
  newChatEachRun: Schema.optionalKey(Schema.Boolean),
  /** Null once a one-off has run, and always null for event routines. */
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
  /** Omitted means `schedule`, so existing callers keep working. */
  trigger: Schema.optional(PersonalRoutineTrigger),
  /** Required for `schedule`, rejected for `event`. */
  schedule: Schema.optional(PersonalRoutineSchedule),
  /** Required for `event`, rejected for `schedule`. */
  eventLabel: Schema.optional(TrimmedNonEmptyString),
  timeZone: Schema.optional(TrimmedNonEmptyString),
  missedPolicy: Schema.optional(PersonalRoutineMissedPolicy),
  /** Omitted means `model`. */
  delivery: Schema.optional(PersonalRoutineDelivery),
  /** The chat to run in; see `PersonalRoutine.threadId`. Omitted: a new chat per run. */
  threadId: Schema.optional(ThreadId),
  /** Omitted means false. */
  newChatEachRun: Schema.optional(Schema.Boolean),
});
export type PersonalRoutineCreateInput = typeof PersonalRoutineCreateInput.Type;

export const PersonalRoutineUpdateInput = Schema.Struct({
  routineId: PersonalRoutineId,
  botId: Schema.optional(PersonalBotId),
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  /** Ignored for event routines, which have no schedule. */
  schedule: Schema.optional(PersonalRoutineSchedule),
  /** Event routines only; ignored for scheduled routines. */
  eventLabel: Schema.optional(TrimmedNonEmptyString),
  timeZone: Schema.optional(TrimmedNonEmptyString),
  missedPolicy: Schema.optional(PersonalRoutineMissedPolicy),
  delivery: Schema.optional(PersonalRoutineDelivery),
  newChatEachRun: Schema.optional(Schema.Boolean),
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

/** Human summary of what starts the routine, for lists and detail headers. */
export function describePersonalRoutineTrigger(routine: {
  readonly schedule: PersonalRoutineSchedule | null;
  readonly eventLabel: string | null;
  readonly timeZone: string;
}): string {
  if (routine.schedule === null) {
    return `On event: ${routine.eventLabel ?? "unnamed event"}`;
  }
  return describePersonalRoutineSchedule(routine.schedule, routine.timeZone);
}

/** Human summary of a schedule, e.g. "Weekdays at 09:00 (Europe/London)". */
export function describePersonalRoutineSchedule(
  schedule: PersonalRoutineSchedule,
  timeZone: string,
): string {
  switch (schedule.kind) {
    case "daily":
      return `Every day at ${schedule.time} (${timeZone})`;
    case "weekly": {
      const days = [...new Set(schedule.days)].sort((left, right) => left - right);
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
