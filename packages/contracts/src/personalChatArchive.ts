/**
 * How long a finished delegated-task chat or routine-run chat waits before the
 * auto-archive sweep closes it.
 *
 * One value drives both waits (the finished-task idle clock and the unread
 * routine report), stored in `personal_meta` as whole minutes under
 * `taskChatAutoArchiveAfterMinutes`. Settings shows it as "30m" / "48h" and
 * the parser here is the only place that reads that text, so the web form and
 * the server agree on every input.
 *
 * Pure: no Effect, no clock, no I/O.
 */

/** The sweep runs every 5 minutes, so a shorter wait could never fire. */
export const PERSONAL_CHAT_ARCHIVE_AFTER_MIN_MINUTES = 5;
/** 720h / 30 days. */
export const PERSONAL_CHAT_ARCHIVE_AFTER_MAX_MINUTES = 720 * 60;
/** 48 hours: the fixed value this setting replaced, and the default. */
export const PERSONAL_CHAT_ARCHIVE_AFTER_DEFAULT_MINUTES = 48 * 60;

/** Shown under the Settings field for any input this module rejects. */
export const PERSONAL_CHAT_ARCHIVE_AFTER_ERROR =
  "Use a number with m or h, e.g. 30m or 48h. 5m to 720h.";

/** Whole minutes inside the allowed range. */
export const personalChatArchiveAfterMinutesValid = (minutes: number): boolean =>
  Number.isSafeInteger(minutes) &&
  minutes >= PERSONAL_CHAT_ARCHIVE_AFTER_MIN_MINUTES &&
  minutes <= PERSONAL_CHAT_ARCHIVE_AFTER_MAX_MINUTES;

/** A whole number, then optional space, then m/h (case-insensitive). */
const DURATION_TEXT = /^(\d+)\s*([mh])?$/i;

/**
 * "30m", "90 M", "48h", "2H" — and a bare number, read as hours. Returns whole
 * minutes, or null for anything malformed (decimals, negatives, other units,
 * words, empty) and anything outside 5m..720h. Never clamps.
 */
export function parsePersonalChatArchiveAfterDuration(text: string): number | null {
  const match = DURATION_TEXT.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value)) return null;
  const minutes = match[2]?.toLowerCase() === "m" ? value : value * 60;
  return personalChatArchiveAfterMinutesValid(minutes) ? minutes : null;
}

/**
 * The stored `personal_meta` text as minutes. Anything absent, unreadable or
 * out of range reads as the 48 hour default, so a bad row can never make the
 * sweep archive sooner than intended.
 */
export function personalChatArchiveAfterMinutesFromStored(
  stored: string | null | undefined,
): number {
  if (stored == null) return PERSONAL_CHAT_ARCHIVE_AFTER_DEFAULT_MINUTES;
  const minutes = Number(stored.trim());
  return personalChatArchiveAfterMinutesValid(minutes)
    ? minutes
    : PERSONAL_CHAT_ARCHIVE_AFTER_DEFAULT_MINUTES;
}

/** What the Settings field shows: whole hours as "2h", everything else as "90m". */
export function formatPersonalChatArchiveAfterDuration(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** The same value in the row's hint: "48 hours", "1 hour", "90 minutes". */
export function personalChatArchiveAfterDurationLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
