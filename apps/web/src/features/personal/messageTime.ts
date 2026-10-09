import { dayKey, formatter, previousDayKey, SHORT_MONTHS } from "./conversationModel";
import { PERSONAL_TIME_ZONE } from "./greeting";

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_MS = 86_400_000;

/** A message's send time as the swipe shows it: the day (none for today) over the clock time. */
export interface MessageTimeParts {
  readonly day: string | null;
  readonly time: string;
}

/** The send time of a message, or null when it has none (or none that reads as a date). */
export function parseSentAt(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function dayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!) / DAY_MS;
}

/**
 * "14:32" today, then "Yesterday", the weekday within the last week ("Thu"),
 * else "8 Oct" (with the year when it is not this year), over the clock time.
 * Days are the personal London days the chat's day dividers use, so the two
 * never disagree about which day a message belongs to.
 */
export function messageTimeParts(
  then: Date,
  now: Date,
  timeZone: string = PERSONAL_TIME_ZONE,
): MessageTimeParts {
  const time = formatter(timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    then,
  );
  const thenDay = dayKey(then, timeZone);
  const nowDay = dayKey(now, timeZone);
  if (thenDay === nowDay) return { day: null, time };
  if (thenDay === previousDayKey(nowDay)) return { day: "Yesterday", time };
  const daysAgo = dayNumber(nowDay) - dayNumber(thenDay);
  if (daysAgo >= 2 && daysAgo < 7) {
    return { day: SHORT_WEEKDAYS[new Date(dayNumber(thenDay) * DAY_MS).getUTCDay()]!, time };
  }
  const [year, month, day] = thenDay.split("-").map(Number);
  const label = `${day} ${SHORT_MONTHS[month! - 1]}`;
  return { day: thenDay.slice(0, 4) === nowDay.slice(0, 4) ? label : `${label} ${year}`, time };
}

/** One line, as spoken or put in a title: "14:32", "Yesterday 14:32", "Thu 14:32", "8 Oct 14:32". */
export function formatMessageTime(
  then: Date,
  now: Date,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const { day, time } = messageTimeParts(then, now, timeZone);
  return day === null ? time : `${day} ${time}`;
}
