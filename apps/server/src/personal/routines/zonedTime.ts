// @effect-diagnostics globalDate:off - pure wall-clock arithmetic over epoch milliseconds, no Effect code.
/**
 * Wall-clock arithmetic in an IANA time zone using only `Intl`. Instants are
 * epoch milliseconds; local times are naive calendar fields in the zone.
 *
 * DST rules used by routines:
 * - ambiguous local time (autumn repeat): the FIRST instant is used;
 * - nonexistent local time (spring gap): the first valid instant after the
 *   gap, i.e. the transition moment (01:30 on a London spring-forward day
 *   runs at 02:00 BST).
 */

export interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface LocalDateTime extends LocalDate {
  readonly hour: number;
  readonly minute: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string) => {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
};

/** Local calendar fields of `instantMs` in `timeZone` (seconds dropped). */
export const localAt = (instantMs: number, timeZone: string): LocalDateTime => {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year!,
    month: fields.month!,
    day: fields.day!,
    // Some engines still print midnight as 24 under h23.
    hour: fields.hour === 24 ? 0 : fields.hour!,
    minute: fields.minute!,
  };
};

/** The local fields as if they were UTC: a comparable "wall" number. */
export const wallMs = (local: LocalDateTime): number =>
  Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);

/** Offset of `timeZone` from UTC at `instantMs`, in ms (BST = +3_600_000). */
export const offsetAt = (instantMs: number, timeZone: string): number => {
  const floored = Math.floor(instantMs / MINUTE_MS) * MINUTE_MS;
  return wallMs(localAt(floored, timeZone)) - floored;
};

export const addDays = (date: LocalDate, days: number): LocalDate => {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
};

/** ISO weekday of a calendar date: 1 = Monday ... 7 = Sunday. */
export const isoWeekday = (date: LocalDate): number => {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return day === 0 ? 7 : day;
};

export type LocalResolution = "exact" | "ambiguous" | "gap";

/** The instant a local wall time happens at, applying the DST rules above. */
export const localToInstant = (
  local: LocalDateTime,
  timeZone: string,
): { readonly instantMs: number; readonly resolution: LocalResolution } => {
  const wall = wallMs(local);
  const offsets = new Set([
    offsetAt(wall - DAY_MS, timeZone),
    offsetAt(wall, timeZone),
    offsetAt(wall + DAY_MS, timeZone),
  ]);
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter((candidate) => wallMs(localAt(candidate, timeZone)) === wall)
    .toSorted((left, right) => left - right);
  if (matches.length > 0) {
    return {
      instantMs: matches[0]!,
      resolution: new Set(matches).size > 1 ? "ambiguous" : "exact",
    };
  }
  // Nonexistent local time: search the gap for the transition instant, the
  // first instant whose local time is at or after the requested one.
  const sorted = [...offsets].toSorted((left, right) => left - right);
  let low = wall - sorted.at(-1)!;
  let high = wall - sorted[0]!;
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
    if (wallMs(localAt(middle, timeZone)) >= wall) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return { instantMs: high, resolution: "gap" };
};

const pad = (value: number) => String(value).padStart(2, "0");

/** `YYYY-MM-DDTHH:MM`, the nominal key of a wall-clock occurrence. */
export const formatLocal = (local: LocalDateTime): string =>
  `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`;

/** `YYYY-MM-DDTHH:MM+HH:MM`: local time with its offset, unambiguous. */
export const formatLocalWithOffset = (instantMs: number, timeZone: string): string => {
  const offsetMinutes = Math.round(offsetAt(instantMs, timeZone) / MINUTE_MS);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  return `${formatLocal(localAt(instantMs, timeZone))}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
};

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export const parseLocal = (value: string): LocalDateTime | null => {
  const match = LOCAL_PATTERN.exec(value);
  if (match === null) return null;
  const local = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  // Round-trip through Date.UTC rejects 2026-02-30 and 25:00.
  const check = new Date(wallMs(local));
  return check.getUTCFullYear() === local.year &&
    check.getUTCMonth() + 1 === local.month &&
    check.getUTCDate() === local.day &&
    check.getUTCHours() === local.hour &&
    check.getUTCMinutes() === local.minute
    ? local
    : null;
};

export const parseTime = (value: string): { hour: number; minute: number } | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
};
