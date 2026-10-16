// @effect-diagnostics globalDate:off - Codex prints its 'try again at' in local calendar time; reading it needs Date's local-time constructor.
/**
 * When the post-update test message failed only because the account is out of
 * usage (a usage limit, a spent window, an empty credit balance), and when to
 * try it again. Pure, so every rule is testable without a clock or a provider;
 * `PersonalProviderUpdates` applies it.
 *
 * Detection is the provider's own words (the smoke tests only return text);
 * the reset time is the error's "try again at ..." when it names one, else the
 * spent window in the provider's usage readings (the same reading the bots'
 * usage-limit fallback uses), else unknown.
 *
 * @module personal/providerUpdates/smokeLimit
 */
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";

import { FALLBACK_MAX_RESET_MS, resetTimeOf } from "../personalModelFallbackPolicy.ts";

/** The retry runs this long after the reset: a window reported as reset can still refuse the first minute. */
export const SMOKE_LIMIT_RETRY_GRACE_MS = 60_000;
/** With no reset time anywhere, the test runs again this long after the failure. */
export const SMOKE_LIMIT_UNKNOWN_RETRY_MS = 30 * 60_000;

const LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\busage limit\b/i,
  /\bhit your (?:\w+ )?limit\b/i,
  /\blimit (?:has been )?reached\b/i,
  /\blimit (?:will )?resets?\b/i,
  /\brate.?limit/i,
  /\btoo many requests\b/i,
  // The status code, not a version number or a port that happens to contain it.
  /(?<![\d.])429(?![\d.])/,
  /\bout of (?:extra )?(?:usage|credits?|tokens?)\b/i,
  /\bcredit balance is too low\b/i,
  /\binsufficient[ _](?:balance|credits?|quota|funds)\b/i,
  /\bexceeded your (?:current )?quota\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
];

/** The provider's error reads like a usage limit or an empty balance rather than a broken CLI. */
export function isUsageLimitFailure(detail: string): boolean {
  return LIMIT_PATTERNS.some((pattern) => pattern.test(detail));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^d/i, 24 * 60 * 60_000],
  [/^h/i, 60 * 60_000],
  [/^m/i, 60_000],
  [/^s/i, 1000],
];

/**
 * The reset time an error names, epoch ms: Codex's "try again at Oct 16th,
 * 2026 12:47 AM" (local time, like every Codex timestamp), "try again at 2:47
 * PM" (the next such time after `baseMs`) and "try again in 2 hours 5 minutes".
 * `baseMs` is when the error was produced. Null when the text names none.
 */
export function limitResetFromText(detail: string, baseMs: number): number | null {
  const relative = /try again in\s+((?:\d+\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(detail);
  if (relative?.[1] !== undefined) {
    let total = 0;
    for (const part of relative[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const unit = UNIT_MS.find(([pattern]) => pattern.test(part[2] ?? ""));
      if (unit === undefined) return null;
      total += Number(part[1]) * unit[1];
    }
    return total > 0 ? baseMs + total : null;
  }
  const absolute =
    /try again (?:at|after|on)\s+(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?)?(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(
      detail,
    );
  if (absolute === null) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = absolute;
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (meridiem !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const base = new Date(baseMs);
  if (monthName === undefined || dayText === undefined) {
    const sameDay = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute);
    const at =
      sameDay.getTime() > baseMs ? sameDay : new Date(sameDay.getTime() + 24 * 60 * 60_000);
    return at.getTime();
  }
  const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const day = Number(dayText);
  if (day < 1 || day > 31) return null;
  const year = yearText === undefined ? base.getFullYear() : Number(yearText);
  let at = new Date(year, month, day, hour, minute).getTime();
  // No year given: a date already behind the error is next year's.
  if (yearText === undefined && at < baseMs - 24 * 60 * 60_000) {
    at = new Date(year + 1, month, day, hour, minute).getTime();
  }
  return at;
}

export interface SmokeLimitFailure {
  readonly model: string;
  readonly detail: string;
}

/**
 * When the limit behind these failures is over (the reset itself; the test runs
 * `SMOKE_LIMIT_RETRY_GRACE_MS` later), epoch ms. The first model to recover is
 * enough to pass the test, so it is the earliest reset among the failures.
 * `allowPast` is for a record read back from disk, whose named time may already
 * be behind us (then the test runs at once); a fresh failure naming a past time
 * is not believed (the provider's reading lags) and falls to the usage readings.
 * Null when nothing says.
 */
export function smokeLimitResetMs(input: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: Pick<ServerProvider, "usageLimits">;
  readonly failures: ReadonlyArray<SmokeLimitFailure>;
  readonly nowMs: number;
  /** When the failures were produced (the record's checkedAt for a stored one). */
  readonly failedAtMs: number;
  readonly allowPast: boolean;
}): number | null {
  let earliest: number | null = null;
  for (const failure of input.failures) {
    const named = limitResetFromText(failure.detail, input.failedAtMs);
    const believedNamed =
      named !== null &&
      Number.isFinite(named) &&
      named - input.nowMs <= FALLBACK_MAX_RESET_MS &&
      (input.allowPast || named > input.nowMs)
        ? named
        : null;
    const candidate =
      believedNamed ??
      resetTimeOf({
        retryAtMs: null,
        home: { instanceId: input.instanceId, model: failure.model } as ModelSelection,
        homeProvider: input.provider,
        nowMs: input.nowMs,
      });
    if (candidate !== null && (earliest === null || candidate < earliest)) earliest = candidate;
  }
  return earliest;
}

/** The persisted retry time: the reset, or "unknown" made into a 30-minute wait. */
export function smokeLimitRetryAtMs(resetMs: number | null, nowMs: number): number {
  return resetMs ?? nowMs + SMOKE_LIMIT_UNKNOWN_RETRY_MS - SMOKE_LIMIT_RETRY_GRACE_MS;
}

/** When the test runs again for a stored retry time. */
export function smokeLimitDueAtMs(retryAtMs: number): number {
  return retryAtMs + SMOKE_LIMIT_RETRY_GRACE_MS;
}
