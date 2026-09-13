import { PERSONAL_TIME_ZONE } from "./greeting";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** `YYYY-MM-DD` calendar day of `date` in `timeZone`. */
function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function previousDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const previous = new Date(Date.UTC(year!, month! - 1, day! - 1));
  return previous.toISOString().slice(0, 10);
}

/**
 * Compact list timestamp: "Now", "4m", "18m", "1h" (same local day),
 * "Yesterday", then "12 Sep" (or "12 Sep 2025" in another year). Future
 * instants (clock skew) read as "Now".
 */
export function formatRelativeTime(
  then: Date | number,
  now: Date | number,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const thenDate = typeof then === "number" ? new Date(then) : then;
  const nowDate = typeof now === "number" ? new Date(now) : now;
  const elapsed = nowDate.getTime() - thenDate.getTime();

  if (elapsed < MINUTE_MS) return "Now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;

  const thenDay = dayKey(thenDate, timeZone);
  const nowDay = dayKey(nowDate, timeZone);
  if (thenDay === nowDay) return `${Math.floor(elapsed / HOUR_MS)}h`;
  if (thenDay === previousDayKey(nowDay)) return "Yesterday";

  // Assembled by hand: ICU's en-GB short month is "Sept", the list wants "Sep".
  const [year, month, day] = thenDay.split("-").map(Number);
  const label = `${day} ${SHORT_MONTHS[month! - 1]}`;
  return thenDay.slice(0, 4) === nowDay.slice(0, 4) ? label : `${label} ${year}`;
}

const SHORT_MONTHS = [
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
