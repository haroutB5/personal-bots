// Pure temporal helpers for memory write-time date grounding, query-intent
// routing, and chronological ordering.
import * as DateTime from "effect/DateTime";

import type { PersonalMemoryEntry } from "@t3tools/contracts";

type MemoryQueryIntent = "temporal_history" | "default";

const MAX_RELATIVE_DAYS = 3_650;
const MAX_RELATIVE_WEEKS = 520;

const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function calendarPartsInTimeZone(
  nowMs: number,
  timeZone?: string,
): { readonly year: number; readonly month: number; readonly day: number } | null {
  if (!Number.isFinite(nowMs)) return null;
  const formatter = new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(nowMs));
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  return { year, month, day };
}

function formatIsoCalendarDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface RelativeMatch {
  readonly index: number;
  readonly deltaDays: number;
}

/**
 * Resolves past/present relative time phrases in `content` (`today`, `yesterday`,
 * `N days ago`, `N weeks ago`, `last week`, `last Monday..Sunday`) to a `YYYY-MM-DD`
 * ISO date relative to `nowMs` (in `timeZone`, or the server's local time zone).
 * Never resolves future dates; returns `null` when no supported past/present
 * phrase is found.
 */
export function groundRelativeDate(
  content: string,
  nowMs: number,
  timeZone?: string,
): string | null {
  const today = calendarPartsInTimeZone(nowMs, timeZone);
  if (today === null) return null;

  const todayUtc = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const todayDow = todayUtc.getUTCDay();
  const candidates: Array<RelativeMatch> = [];

  const todayMatch = /\btoday\b/i.exec(content);
  if (todayMatch !== null) {
    candidates.push({ index: todayMatch.index, deltaDays: 0 });
  }

  const yesterdayMatch = /\byesterday\b/i.exec(content);
  if (yesterdayMatch !== null) {
    candidates.push({ index: yesterdayMatch.index, deltaDays: -1 });
  }

  const daysAgoMatch = /\b(\d+)\s+days?\s+ago\b/i.exec(content);
  if (daysAgoMatch !== null) {
    const count = Number(daysAgoMatch[1]);
    if (Number.isInteger(count) && count >= 0 && count <= MAX_RELATIVE_DAYS) {
      candidates.push({ index: daysAgoMatch.index, deltaDays: -count });
    }
  }

  const aDayAgoMatch = /\ba\s+day\s+ago\b/i.exec(content);
  if (aDayAgoMatch !== null) {
    candidates.push({ index: aDayAgoMatch.index, deltaDays: -1 });
  }

  const weeksAgoMatch = /\b(\d+)\s+weeks?\s+ago\b/i.exec(content);
  if (weeksAgoMatch !== null) {
    const count = Number(weeksAgoMatch[1]);
    if (Number.isInteger(count) && count >= 0 && count <= MAX_RELATIVE_WEEKS) {
      candidates.push({ index: weeksAgoMatch.index, deltaDays: -count * 7 });
    }
  }

  const aWeekAgoMatch = /\ba\s+week\s+ago\b/i.exec(content);
  if (aWeekAgoMatch !== null) {
    candidates.push({ index: aWeekAgoMatch.index, deltaDays: -7 });
  }

  const lastWeekMatch = /\blast\s+week\b/i.exec(content);
  if (lastWeekMatch !== null) {
    candidates.push({ index: lastWeekMatch.index, deltaDays: -7 });
  }

  const lastWeekdayMatch =
    /\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(content);
  if (lastWeekdayMatch !== null) {
    const targetDow = WEEKDAYS[lastWeekdayMatch[1]!.toLowerCase()];
    if (targetDow !== undefined) {
      const diff = (todayDow - targetDow + 7) % 7;
      candidates.push({
        index: lastWeekdayMatch.index,
        deltaDays: -(diff === 0 ? 7 : diff),
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  const chosen = candidates[0]!;
  if (chosen.deltaDays > 0) return null;

  const resolved = new Date(Date.UTC(today.year, today.month - 1, today.day + chosen.deltaDays));
  if (!Number.isFinite(resolved.getTime()) || resolved.getTime() > todayUtc.getTime()) {
    return null;
  }
  return formatIsoCalendarDate(resolved);
}

const TEMPORAL_HISTORY_PATTERN =
  /\b(?:when\s+(?:did|was|were)|what\s+changed|used\s+to|previously|previous|before|history\s+of|(?:change|version)\s+history|timeline|originally|last\s+time|since\s+when|back\s+when|formerly)\b/i;

/**
 * Classifies whether a query asks about past states, changes over time, or
 * historical timelines, vs a normal current-state lookup.
 */
export function classifyMemoryQueryIntent(query: string): MemoryQueryIntent {
  return TEMPORAL_HISTORY_PATTERN.test(query) ? "temporal_history" : "default";
}

/** Epoch ms used for chronological ordering: `observedAt` when valid, else `createdAt`. */
function temporalTimestampMs(entry: Pick<PersonalMemoryEntry, "observedAt" | "createdAt">): number {
  if (entry.observedAt != null) {
    const parsed = Date.parse(entry.observedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DateTime.toEpochMillis(entry.createdAt);
}

/** Orders memory entries chronologically (`observedAt ?? createdAt` ascending). */
export function sortChronologically<
  T extends Pick<PersonalMemoryEntry, "observedAt" | "createdAt" | "memoryId">,
>(entries: ReadonlyArray<T>): ReadonlyArray<T> {
  return entries.toSorted(
    (a, b) =>
      temporalTimestampMs(a) - temporalTimestampMs(b) ||
      DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
      a.memoryId.localeCompare(b.memoryId),
  );
}
