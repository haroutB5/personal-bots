import type {
  PersonalMemoryTidyAction,
  PersonalMemoryTidyMode,
  PersonalMemoryTidyRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { PERSONAL_TIME_ZONE } from "./greeting";
import { formatRelativeTime } from "./relativeTime";

/** `YYYY-MM-DD` of an instant, on the app's local calendar. */
export function memoryDayLabel(then: Date | number, timeZone: string = PERSONAL_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(typeof then === "number" ? new Date(then) : then);
}

/** `YYYY-MM-DD HH:mm` (24-hour) of an instant, on the app's local calendar. */
export function memoryDayTimeLabel(
  then: Date | number,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const date = typeof then === "number" ? new Date(then) : then;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${memoryDayLabel(date, timeZone)} ${time}`;
}

/** An entry's footer: "Saved by you · 2026-10-01 · 3h". */
export function memoryMetaLine(
  source: string,
  then: Date | number,
  now: Date | number,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  return `${source} · ${memoryDayLabel(then, timeZone)} · ${formatRelativeTime(then, now, timeZone)}`;
}

export const TIDY_MODES: ReadonlyArray<PersonalMemoryTidyMode> = ["off", "preview", "on"];

export const TIDY_MODE_LABEL: Readonly<Record<PersonalMemoryTidyMode, string>> = {
  off: "Off",
  preview: "Preview only",
  on: "Make changes",
};

export const TIDY_ACTION_LABEL: Readonly<Record<PersonalMemoryTidyAction, string>> = {
  merge: "Merged",
  supersede: "Replaced",
  leave: "Left alone",
};

const TIDY_STATUS_LABEL: Readonly<Record<PersonalMemoryTidyRun["status"], string>> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
};

export function tidyStatusLabel(status: PersonalMemoryTidyRun["status"]): string {
  return TIDY_STATUS_LABEL[status];
}

/** A preview only listed its changes; a real run made them. */
export function tidyRunKindLabel(run: Pick<PersonalMemoryTidyRun, "dryRun">): string {
  return run.dryRun ? "Preview" : "Changes made";
}

/** "2 merged, 3 replaced, 1 left alone"; zero counts are left out. */
export function tidyCountsLabel(
  run: Pick<PersonalMemoryTidyRun, "merged" | "superseded" | "leftAlone">,
): string {
  const parts: string[] = [];
  if (run.merged > 0) parts.push(`${run.merged} merged`);
  if (run.superseded > 0) parts.push(`${run.superseded} replaced`);
  if (run.leftAlone > 0) parts.push(`${run.leftAlone} left alone`);
  return parts.length === 0 ? "Nothing to tidy" : parts.join(", ");
}

/** Newest first by start time, without touching the input. */
export function newestTidyRunsFirst<T extends Pick<PersonalMemoryTidyRun, "startedAt">>(
  runs: ReadonlyArray<T>,
): T[] {
  return runs.toSorted(
    (a, b) => DateTime.toEpochMillis(b.startedAt) - DateTime.toEpochMillis(a.startedAt),
  );
}

/**
 * The tidy-up's one-line status: "Preview only · last run 2026-10-01 03:30:
 * 2 merged, 1 replaced". `lastRun` is the newest run, if any.
 */
export function tidySummaryLine(
  mode: PersonalMemoryTidyMode,
  lastRun: Pick<
    PersonalMemoryTidyRun,
    "startedAt" | "status" | "merged" | "superseded" | "leftAlone"
  > | null,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const modeLabel = TIDY_MODE_LABEL[mode];
  if (lastRun === null) return `${modeLabel} · not run yet`;
  const when = memoryDayTimeLabel(DateTime.toEpochMillis(lastRun.startedAt), timeZone);
  const outcome =
    lastRun.status === "done" ? tidyCountsLabel(lastRun) : tidyStatusLabel(lastRun.status);
  return `${modeLabel} · last run ${when}: ${outcome}`;
}

/** What the changelog says for an id that is in neither list any more. */
export const UNLISTED_MEMORY_TEXT = "an entry no longer listed";

/** memoryId to text, across the current and replaced lists (current wins). */
export function memoryTextLookup(
  ...lists: ReadonlyArray<
    ReadonlyArray<{ readonly memoryId: string; readonly content: string }> | null | undefined
  >
): ReadonlyMap<string, string> {
  const texts = new Map<string, string>();
  for (const list of lists) {
    for (const entry of list ?? []) {
      if (!texts.has(entry.memoryId)) texts.set(entry.memoryId, entry.content);
    }
  }
  return texts;
}

/** The texts of a change's entries, in order, with a plain fallback for unknown ids. */
export function tidyEntryTexts(
  memoryIds: ReadonlyArray<string>,
  texts: ReadonlyMap<string, string>,
): string[] {
  return memoryIds.map((memoryId) => texts.get(memoryId) ?? UNLISTED_MEMORY_TEXT);
}

/** "1 change" / "4 changes". */
export function tidyChangeCountLabel(count: number): string {
  return count === 1 ? "1 change" : `${count} changes`;
}
