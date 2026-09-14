import {
  PERSONAL_ROUTINE_DEFAULT_TIME_ZONE,
  type PersonalRoutine,
  type PersonalRoutineMissedPolicy,
  type PersonalRoutineSchedule,
  type PersonalRoutineTrigger,
} from "@t3tools/contracts";

export type RoutineScheduleKind = PersonalRoutineSchedule["kind"];

/** Editable form state; every field is a string/array as the inputs hold it. */
export interface RoutineDraft {
  readonly botId: string;
  readonly title: string;
  readonly prompt: string;
  /** Fixed once the routine exists; the form only offers it on create. */
  readonly trigger: PersonalRoutineTrigger;
  /** Event routines only, e.g. "PR merged". */
  readonly eventLabel: string;
  readonly kind: RoutineScheduleKind;
  readonly time: string;
  readonly days: ReadonlyArray<number>;
  readonly everyHours: string;
  readonly date: string;
  readonly timeZone: string;
  readonly missedPolicy: PersonalRoutineMissedPolicy;
}

export const WEEKDAYS: ReadonlyArray<{ readonly day: number; readonly short: string }> = [
  { day: 1, short: "Mon" },
  { day: 2, short: "Tue" },
  { day: 3, short: "Wed" },
  { day: 4, short: "Thu" },
  { day: 5, short: "Fri" },
  { day: 6, short: "Sat" },
  { day: 7, short: "Sun" },
];

/** `YYYY-MM-DD` of `now` in `timeZone`. */
export function todayInZone(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function draftFromRoutine(
  routine: PersonalRoutine | null,
  fallbackBotId: string,
  today: string,
): RoutineDraft {
  const base: RoutineDraft = {
    botId: routine?.botId ?? fallbackBotId,
    title: routine?.title ?? "",
    prompt: routine?.prompt ?? "",
    trigger: routine?.trigger ?? "schedule",
    eventLabel: routine?.eventLabel ?? "",
    kind: "daily",
    time: "09:00",
    days: [1, 2, 3, 4, 5],
    everyHours: "4",
    date: today,
    timeZone: routine?.timeZone ?? PERSONAL_ROUTINE_DEFAULT_TIME_ZONE,
    missedPolicy: routine?.missedPolicy ?? "coalesce",
  };
  if (routine === null) return base;
  const schedule = routine.schedule;
  // An event routine has no schedule at all; the defaults above are only there
  // so the hidden schedule inputs stay controlled.
  if (schedule === null) return base;
  switch (schedule.kind) {
    case "daily":
      return { ...base, kind: "daily", time: schedule.time };
    case "weekly":
      return { ...base, kind: "weekly", time: schedule.time, days: schedule.days };
    case "interval":
      return { ...base, kind: "interval", everyHours: String(schedule.everyHours) };
    case "once":
      return { ...base, kind: "once", date: schedule.at.slice(0, 10), time: schedule.at.slice(11) };
  }
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The schedule the draft describes, or the first problem with it. */
export function scheduleFromDraft(
  draft: RoutineDraft,
): { readonly schedule: PersonalRoutineSchedule } | { readonly error: string } {
  if (draft.kind !== "interval" && !TIME.test(draft.time)) {
    return { error: "Pick a time." };
  }
  switch (draft.kind) {
    case "daily":
      return { schedule: { kind: "daily", time: draft.time } };
    case "weekly":
      return draft.days.length === 0
        ? { error: "Pick at least one day." }
        : {
            schedule: {
              kind: "weekly",
              days: [...draft.days].toSorted((left, right) => left - right),
              time: draft.time,
            },
          };
    case "interval": {
      const hours = Number(draft.everyHours);
      return Number.isInteger(hours) && hours >= 1 && hours <= 168
        ? { schedule: { kind: "interval", everyHours: hours } }
        : { error: "Hours must be a whole number from 1 to 168." };
    }
    case "once":
      return DATE.test(draft.date)
        ? { schedule: { kind: "once", at: `${draft.date}T${draft.time}` } }
        : { error: "Pick a date." };
  }
}

/** Equal schedules, ignoring the server-owned interval anchor. */
export function sameSchedule(
  left: PersonalRoutineSchedule,
  right: PersonalRoutineSchedule,
): boolean {
  const strip = (schedule: PersonalRoutineSchedule) =>
    schedule.kind === "interval"
      ? { kind: schedule.kind, everyHours: schedule.everyHours }
      : schedule;
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
}
