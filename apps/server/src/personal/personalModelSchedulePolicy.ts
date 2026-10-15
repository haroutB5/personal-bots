import * as DateTime from "effect/DateTime";
import {
  type ModelSelection,
  PERSONAL_FALLBACK_REASON_SCHEDULE,
  type PersonalBotSchedule,
  scheduleMatchesOwnModel,
} from "@t3tools/contracts";

/**
 * Per-bot model schedule: "Use a different model at set times".
 *
 * Between a start and an end time of day (the laptop's local time, every day;
 * an overnight range such as 22:00 to 07:00 is fine) a bot runs its turns on a
 * chosen model instead of its own. It rides the usage-limit fallback row with
 * the reason `schedule`, whose `resetAt` is the end of the window that is open,
 * so every turn path the server has picks it up, exactly like the DeepSeek peak
 * switch does.
 *
 * Whether a window is open is decided from the local WALL CLOCK at the instant
 * (hour and minute in the laptop's time zone), never by adding hours, so a day
 * the clocks change (25 Oct 2026, 28 Mar 2027) keeps the window at the times
 * the owner typed.
 *
 * Pure: the clock and the time zone are arguments, so the whole thing is
 * testable.
 */

/** Set to "off" (or 0, false, no, disabled) to turn every model schedule off. */
export const PERSONAL_MODEL_SCHEDULE_ENV = "PERSONAL_MODEL_SCHEDULE";

export function modelScheduleEnabledByEnv(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !/^(off|0|false|no|disabled)$/i.test(value.trim());
}

/**
 * Tests only: an instant (epoch ms or ISO) that replaces the clock for the
 * schedule decision, like `PERSONAL_DEEPSEEK_PEAK_NOW` does for the peak one.
 * Read on every sweep.
 */
export const PERSONAL_MODEL_SCHEDULE_NOW_ENV = "PERSONAL_MODEL_SCHEDULE_NOW";

/** True when a stored fallback row is the model schedule rather than a limit or the peak switch. */
export const isScheduleFallback = (state: { readonly reason: string | null }): boolean =>
  state.reason === PERSONAL_FALLBACK_REASON_SCHEDULE;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "22:30" as minutes since midnight; null when it is not a 24 h "HH:MM". */
export function parseTimeOfDay(text: string): number | null {
  const match = TIME_PATTERN.exec(text);
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes since midnight as "HH:MM". */
export function formatTimeOfDay(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** The time zone of this process: the laptop's. */
export const localTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * Tests only: an IANA zone name (`Europe/London`) that replaces the laptop's
 * zone for the schedule decision, so a test does not depend on the machine it
 * runs on. An unknown name is ignored.
 */
export const PERSONAL_MODEL_SCHEDULE_TZ_ENV = "PERSONAL_MODEL_SCHEDULE_TZ";

/** The zone schedule times are read in: the override when it is a real zone, else the laptop's. */
export function scheduleTimeZone(override: string | undefined): string {
  const wanted = override?.trim() ?? "";
  if (wanted !== "") {
    try {
      Intl.DateTimeFormat("en-GB", { timeZone: wanted });
      return wanted;
    } catch {
      // An unknown zone name: use the laptop's.
    }
  }
  return localTimeZone();
}

interface LocalClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minuteOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const known = formatters.get(timeZone);
  if (known !== undefined) return known;
  const created = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  formatters.set(timeZone, created);
  return created;
}

/** The wall clock in `timeZone` at the instant `atMs`. */
export function localClockAt(atMs: number, timeZone: string): LocalClock {
  const parts = formatterFor(timeZone).formatToParts(atMs);
  const read = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    minuteOfDay: (read("hour") % 24) * 60 + read("minute"),
  };
}

/** How far the zone's wall clock is ahead of UTC at `atMs`, in ms (minute precision). */
function offsetAt(atMs: number, timeZone: string): number {
  const clock = localClockAt(atMs, timeZone);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day) + clock.minuteOfDay * 60_000;
  return asUtc - Math.floor(atMs / 60_000) * 60_000;
}

/**
 * The instant at which `timeZone`'s wall clock reads `minuteOfDay` on the
 * local calendar day `year-month-day`. A time that does not exist (the hour
 * the clocks skip) lands on the first instant after the gap; a time that
 * happens twice lands on its later occurrence.
 */
export function wallTimeToEpochMs(
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
  timeZone: string,
): number {
  const guess = Date.UTC(year, month - 1, day) + minuteOfDay * 60_000;
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

export interface ScheduleWindow {
  /** Minutes since local midnight. */
  readonly fromMinutes: number;
  readonly toMinutes: number;
}

/** The window a stored schedule names; null when a time is malformed or the two are equal. */
export function scheduleWindowOf(
  schedule: Pick<PersonalBotSchedule, "from" | "to">,
): ScheduleWindow | null {
  const fromMinutes = parseTimeOfDay(schedule.from);
  const toMinutes = parseTimeOfDay(schedule.to);
  if (fromMinutes === null || toMinutes === null || fromMinutes === toMinutes) return null;
  return { fromMinutes, toMinutes };
}

/** Whether the daily window is open at the wall-clock minute `minuteOfDay`. */
export function windowOpenAtMinute(window: ScheduleWindow, minuteOfDay: number): boolean {
  return window.fromMinutes < window.toMinutes
    ? minuteOfDay >= window.fromMinutes && minuteOfDay < window.toMinutes
    : minuteOfDay >= window.fromMinutes || minuteOfDay < window.toMinutes;
}

/**
 * When the window that is open at `atMs` closes (epoch ms), or null when it is
 * not open. An overnight window that opened yesterday closes today; one that
 * opened today closes tomorrow.
 */
export function windowEndMs(window: ScheduleWindow, atMs: number, timeZone: string): number | null {
  const clock = localClockAt(atMs, timeZone);
  if (!windowOpenAtMinute(window, clock.minuteOfDay)) return null;
  const closesTomorrow =
    window.fromMinutes > window.toMinutes && clock.minuteOfDay >= window.fromMinutes;
  // Calendar arithmetic through UTC midnight: the local date plus one day.
  const date = DateTime.toParts(
    DateTime.makeUnsafe(
      Date.UTC(clock.year, clock.month - 1, clock.day + (closesTomorrow ? 1 : 0)),
    ),
  );
  const end = wallTimeToEpochMs(date.year, date.month, date.day, window.toMinutes, timeZone);
  // On a day the clocks change the wall time can resolve at or before now; the
  // next sweep decides again, so a minute ahead is a safe answer.
  return end > atMs ? end : atMs + 60_000;
}

export interface ScheduleStateInput {
  /** The schedule clock: the real time, or the test override. */
  readonly atMs: number;
  readonly timeZone: string;
  /** `PERSONAL_MODEL_SCHEDULE` is not off. */
  readonly killSwitchOn: boolean;
  readonly schedule: PersonalBotSchedule | undefined;
  /** The bot's own (saved) model. */
  readonly home: ModelSelection;
}

export type ScheduleState =
  | { readonly kind: "open"; readonly untilMs: number; readonly selection: ModelSelection }
  | {
      readonly kind: "closed";
      readonly reason:
        | "kill_switch"
        | "no_schedule"
        | "disabled"
        | "invalid_range"
        | "same_model"
        | "outside";
    };

/** Whether a bot's scheduled window is open right now, and the model it names. */
export function scheduleState(input: ScheduleStateInput): ScheduleState {
  if (!input.killSwitchOn) return { kind: "closed", reason: "kill_switch" };
  const schedule = input.schedule;
  if (schedule === undefined) return { kind: "closed", reason: "no_schedule" };
  if (!schedule.enabled) return { kind: "closed", reason: "disabled" };
  const window = scheduleWindowOf(schedule);
  if (window === null) return { kind: "closed", reason: "invalid_range" };
  // A schedule onto the model the bot already runs on changes nothing.
  if (scheduleMatchesOwnModel(input.home, schedule.modelSelection)) {
    return { kind: "closed", reason: "same_model" };
  }
  const untilMs = windowEndMs(window, input.atMs, input.timeZone);
  if (untilMs === null) return { kind: "closed", reason: "outside" };
  return { kind: "open", untilMs, selection: schedule.modelSelection };
}

/** What the server refuses, in the owner's words; null when the schedule is fine. */
export function scheduleProblem(
  schedule: Pick<PersonalBotSchedule, "from" | "to" | "modelSelection">,
  home: ModelSelection,
): string | null {
  if (parseTimeOfDay(schedule.from) === null || parseTimeOfDay(schedule.to) === null) {
    return "Times are 24 hour, like 22:00.";
  }
  if (schedule.from === schedule.to) return "From and To can't be the same time.";
  if (scheduleMatchesOwnModel(home, schedule.modelSelection)) {
    return "Pick a different model from the bot's own.";
  }
  return null;
}
