// @effect-diagnostics globalDate:off - the reset is a wall-clock time in a named zone; reading it needs Intl over Date.
/**
 * The reset a Claude limit names only in text ("resets 5:50am (Europe/London)",
 * "resets Nov 20, 9am (Europe/London)") when the turn has no structured reset.
 * @module orchestration-v2/Adapters/claudeLimitResetText
 */

const RESET_TEXT =
  /\bresets\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([a-z][a-z0-9_+\-/]*)\)/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const DAY_MS = 24 * 60 * 60_000;
/** A named reset further out than this is not believed (the longest window is a week). */
const MAX_AHEAD_MS = 31 * DAY_MS;

interface WallDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const wallDateIn = (
  epochMs: number,
  timeZone: string,
): WallDate & { readonly offsetMs: number } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const year = part("year");
  const month = part("month") - 1;
  const day = part("day");
  const asUtc = Date.UTC(year, month, day, part("hour"), part("minute"), part("second"));
  return { year, month, day, offsetMs: asUtc - Math.floor(epochMs / 1000) * 1000 };
};

/** The instant a wall-clock time in `timeZone` names; the second pass settles a DST edge. */
const zonedEpochMs = (date: WallDate, hour: number, minute: number, timeZone: string): number => {
  const wall = Date.UTC(date.year, date.month, date.day, hour, minute);
  const first = wall - wallDateIn(wall, timeZone).offsetMs;
  return wall - wallDateIn(first, timeZone).offsetMs;
};

/**
 * The reset the text names, as an ISO instant, or undefined when it names none
 * (or one this cannot place). `baseMs` is when the text was produced: a time
 * without a date is the next such time after it.
 */
export function claudeLimitResetFromText(text: string, baseMs: number): string | undefined {
  const match = RESET_TEXT.exec(text);
  if (match === null || !Number.isFinite(baseMs)) return undefined;
  const [, monthName, dayText, hourText, minuteText, meridiem, timeZone] = match;
  let hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || timeZone === undefined) return undefined;
  let today: WallDate;
  try {
    today = wallDateIn(baseMs, timeZone);
  } catch {
    return undefined;
  }
  let resetMs: number;
  if (monthName === undefined || dayText === undefined) {
    resetMs = zonedEpochMs(today, hour, minute, timeZone);
    if (resetMs <= baseMs) {
      resetMs = zonedEpochMs({ ...today, day: today.day + 1 }, hour, minute, timeZone);
    }
  } else {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    const day = Number(dayText);
    if (month < 0 || day < 1 || day > 31) return undefined;
    resetMs = zonedEpochMs({ year: today.year, month, day }, hour, minute, timeZone);
    if (resetMs < baseMs - DAY_MS) {
      resetMs = zonedEpochMs({ year: today.year + 1, month, day }, hour, minute, timeZone);
    }
  }
  return resetMs > baseMs && resetMs - baseMs <= MAX_AHEAD_MS
    ? new Date(resetMs).toISOString()
    : undefined;
}
