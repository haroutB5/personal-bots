import * as DateTime from "effect/DateTime";

/**
 * Pin, snooze and the wake clock for chats and groups. Pure: every function
 * takes the time it needs, so the screens (and the tests) decide what "now"
 * is. All wall-clock words ("this evening", "tomorrow 09:00") are in the
 * device's own time zone.
 *
 * The server sends `pinnedAt` only on a pinned chat and `snoozedUntil` only on
 * a chat that is snoozed right now (a group sends it as stored, so one in the
 * past means awake). The client also treats a snooze whose time has passed as
 * over, without waiting for the refetch, which is what `nowMs` is for.
 */

/** What a chat link or a group carries about pin and snooze. */
export interface ChatStateFields {
  readonly pinnedAt?: DateTime.Utc | undefined;
  readonly snoozedUntil?: DateTime.Utc | undefined;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function isChatPinned(item: Pick<ChatStateFields, "pinnedAt">): boolean {
  return item.pinnedAt !== undefined && item.pinnedAt !== null;
}

/** When the snooze ends, in epoch ms, or null when it is over (or never was). */
export function snoozeEndMs(
  item: Pick<ChatStateFields, "snoozedUntil">,
  nowMs: number,
): number | null {
  if (item.snoozedUntil === undefined || item.snoozedUntil === null) return null;
  const until = DateTime.toEpochMillis(item.snoozedUntil);
  return until > nowMs ? until : null;
}

export function isChatSnoozed(item: Pick<ChatStateFields, "snoozedUntil">, nowMs: number): boolean {
  return snoozeEndMs(item, nowMs) !== null;
}

/** The nearest wake time still ahead, or null when nothing is snoozed. */
export function nextWakeAtMs(
  items: ReadonlyArray<Pick<ChatStateFields, "snoozedUntil">>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const item of items) {
    const until = snoozeEndMs(item, nowMs);
    if (until !== null && (next === null || until < next)) next = until;
  }
  return next;
}

/**
 * Pinned rows first, the rest after, each part keeping the order it came in
 * (the callers pass newest activity first, so pinned reads newest first too).
 */
export function pinnedFirst<T>(rows: ReadonlyArray<T>, isPinned: (row: T) => boolean): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (isPinned(row) ? pinned : rest).push(row);
  return [...pinned, ...rest];
}

/** Soonest wake first, for the Snoozed sections. */
export function soonestWakeFirst<T>(rows: ReadonlyArray<T>, wakeMs: (row: T) => number): T[] {
  return rows.toSorted((left, right) => wakeMs(left) - wakeMs(right));
}

// --- Snooze presets -------------------------------------------------------------

export type SnoozePresetKey = "hour" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly key: SnoozePresetKey;
  readonly label: string;
  /** What the choice means in words ("Today 18:00"), shown under the label. */
  readonly detail: string;
  readonly untilMs: number;
}

/** "This evening" is offered while it is before this hour, local time. */
export const EVENING_CUTOFF_HOUR = 17;
export const EVENING_HOUR = 18;
export const MORNING_HOUR = 9;

function atLocal(base: Date, dayOffset: number, hour: number): Date {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * The words after "Wakes": "today 18:00", "tomorrow 09:00", "Mon 12 Oct 09:00"
 * (the year is added when it is not this one).
 */
function whenWords(untilMs: number, nowMs: number): string {
  const until = new Date(untilMs);
  const now = new Date(nowMs);
  if (sameLocalDay(until, now)) return `today ${clock(until)}`;
  if (sameLocalDay(until, atLocal(now, 1, 0))) return `tomorrow ${clock(until)}`;
  const year = until.getFullYear() === now.getFullYear() ? "" : ` ${until.getFullYear()}`;
  return `${WEEKDAYS[until.getDay()]} ${until.getDate()} ${MONTHS[until.getMonth()]}${year} ${clock(until)}`;
}

/** "Wakes today 18:00", "Wakes tomorrow 09:00", "Wakes Mon 12 Oct 09:00". */
export function wakeLabel(untilMs: number, nowMs: number): string {
  return untilMs <= nowMs ? "Waking now" : `Wakes ${whenWords(untilMs, nowMs)}`;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The snooze choices at `now`: In 1 hour, This evening (18:00, only before
 * 17:00), Tomorrow (09:00) and Next week (the next Monday 09:00; from a Monday
 * it is the Monday after).
 */
export function snoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const nowMs = now.getTime();
  const presets: SnoozePreset[] = [];
  const preset = (key: SnoozePresetKey, label: string, untilMs: number) =>
    presets.push({ key, label, detail: capitalised(whenWords(untilMs, nowMs)), untilMs });
  preset("hour", "In 1 hour", nowMs + HOUR_MS);
  if (now.getHours() < EVENING_CUTOFF_HOUR) {
    preset("evening", "This evening", atLocal(now, 0, EVENING_HOUR).getTime());
  }
  preset("tomorrow", "Tomorrow", atLocal(now, 1, MORNING_HOUR).getTime());
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  preset("next-week", "Next week", atLocal(now, daysToMonday, MORNING_HOUR).getTime());
  return presets;
}
