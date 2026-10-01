import type {
  PersonalMemoryEntry,
  PersonalMemoryTidyAction,
  PersonalMemoryTidyChange,
  PersonalMemoryTidyChangeStatus,
  PersonalMemoryTidyMode,
  PersonalMemoryTidyRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { personalBotTeamLabel } from "@t3tools/contracts";

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
  reclassify: "Reclassified",
  save: "New entry",
  forget: "Forgotten",
  leave: "Left alone",
};

export const TIDY_CHANGE_STATUS_LABEL: Readonly<Record<PersonalMemoryTidyChangeStatus, string>> = {
  applied: "Done",
  preview: "Preview",
  pending: "Waiting for you",
  approved: "Approved",
  rejected: "Rejected",
  left: "Left alone",
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
  pendingCount: number = 0,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const modeLabel = TIDY_MODE_LABEL[mode];
  const waiting = pendingCount > 0 ? ` · ${pendingCount} waiting for your OK` : "";
  if (lastRun === null) return `${modeLabel} · not run yet${waiting}`;
  const when = memoryDayTimeLabel(DateTime.toEpochMillis(lastRun.startedAt), timeZone);
  const outcome =
    lastRun.status === "done" ? tidyCountsLabel(lastRun) : tidyStatusLabel(lastRun.status);
  return `${modeLabel} · last run ${when}: ${outcome}${waiting}`;
}

/** Every change still waiting for the owner's OK, across the runs given, in their order. */
export function pendingTidyChanges<C extends Pick<PersonalMemoryTidyChange, "changeId" | "status">>(
  runs: ReadonlyArray<{ readonly changes: ReadonlyArray<C> }>,
): C[] {
  const seen = new Set<number>();
  const pending: C[] = [];
  for (const run of runs) {
    for (const change of run.changes) {
      if (change.status !== "pending" || seen.has(change.changeId)) continue;
      seen.add(change.changeId);
      pending.push(change);
    }
  }
  return pending;
}

/** A change's action in words; a reclassify still waiting reads as a request. */
export function tidyActionLabel(
  change: Pick<PersonalMemoryTidyChange, "action" | "status">,
): string {
  if (change.status === "pending") {
    if (change.action === "reclassify") return "Reclassify";
    if (change.action === "save") return "Save";
    if (change.action === "forget") return "Forget";
  }
  return TIDY_ACTION_LABEL[change.action];
}

/**
 * What a reclassify does, in words: "Make it a preference · Reach: Dev team".
 * Empty when it names no new kind or reach.
 */
export function reclassifyDescription(
  change: Pick<PersonalMemoryTidyChange, "toKind" | "toScope" | "toScopeId">,
): string {
  const parts: string[] = [];
  if (change.toKind === "preference") parts.push("Make it a preference");
  if (change.toKind === "note") parts.push("Make it a note");
  if (change.toScope === "shared") parts.push("Reach: All bots");
  if (change.toScope === "team") {
    const team = change.toScopeId?.trim();
    parts.push(`Reach: ${team ? personalBotTeamLabel(team) : "one team"}`);
  }
  return parts.join(" · ");
}

/** Who proposed a change, by name: the bot's, or "A bot" when it is not listed. */
export function proposerBotName(
  proposedBy: string | null | undefined,
  botName: (botId: string) => string | undefined,
): string {
  if (proposedBy?.startsWith("bot:")) return botName(proposedBy.slice(4)) ?? "A bot";
  return "A bot";
}

/** "From the nightly tidy-up" / "From CTO" / "From the file notes.md"; null when unknown. */
export function tidyProvenanceLabel(
  proposedBy: string | null | undefined,
  botName: (botId: string) => string | undefined,
): string | null {
  if (proposedBy === undefined || proposedBy === null || proposedBy.trim() === "") return null;
  if (proposedBy === "tidy-up") return "From the nightly tidy-up";
  if (proposedBy.startsWith("bot:")) return `From ${botName(proposedBy.slice(4)) ?? "a bot"}`;
  if (proposedBy.startsWith("file:")) return `From the file ${proposedBy.slice(5).trim()}`;
  return `From ${proposedBy}`;
}

/**
 * A bot's request in words: "CTO wants to save a preference for Dev team",
 * "CTO asks to forget:". Empty for other actions.
 */
export function tidyRequestHeadline(
  change: Pick<
    PersonalMemoryTidyChange,
    "action" | "proposedBy" | "toKind" | "toScope" | "toScopeId"
  >,
  botName: (botId: string) => string | undefined,
): string {
  const who = proposerBotName(change.proposedBy, botName);
  if (change.action === "forget") return `${who} asks to forget:`;
  if (change.action !== "save") return "";
  const kind = change.toKind === "preference" ? "preference" : "note";
  const team = change.toScopeId?.trim();
  const reach =
    change.toScope === "shared"
      ? " for All bots"
      : change.toScope === "team"
        ? ` for ${team ? personalBotTeamLabel(team) : "one team"}`
        : "";
  return `${who} wants to save a ${kind}${reach}`;
}

const PROPOSALS_PREFIX = "proposals: ";
const BOT_REQUESTS_PREFIX = "from bots, ";

/** "2 Oct 03:30" on the app's local calendar. */
function shortDayTime(then: number, timeZone: string): string {
  const [, month, day] = memoryDayLabel(then, timeZone).split("-").map(Number);
  const time = memoryDayTimeLabel(then, timeZone).slice(11);
  return `${day} ${SHORT_MONTHS[month! - 1]} ${time}`;
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

/** A run's group header: "Proposals: <name>" for a one-off list, else "Nightly tidy-up 2 Oct 03:30". */
export function tidyRunGroupLabel(
  run: Pick<PersonalMemoryTidyRun, "model" | "startedAt">,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const model = run.model ?? "";
  if (model.startsWith(PROPOSALS_PREFIX)) {
    const name = model.slice(PROPOSALS_PREFIX.length).trim();
    if (name.startsWith(BOT_REQUESTS_PREFIX)) {
      return `Bot requests ${name.slice(BOT_REQUESTS_PREFIX.length).trim()}`.trim();
    }
    return name === "" ? "Proposals" : `Proposals: ${name}`;
  }
  return `Nightly tidy-up ${shortDayTime(DateTime.toEpochMillis(run.startedAt), timeZone)}`;
}

/** Pending changes grouped by their run (runs in the order given, empty groups dropped). */
export function pendingTidyGroups<C extends Pick<PersonalMemoryTidyChange, "changeId" | "status">>(
  runs: ReadonlyArray<
    Pick<PersonalMemoryTidyRun, "runId" | "model" | "startedAt"> & {
      readonly changes: ReadonlyArray<C>;
    }
  >,
  timeZone: string = PERSONAL_TIME_ZONE,
): Array<{ runId: string; label: string; changes: C[] }> {
  const seen = new Set<number>();
  const groups: Array<{ runId: string; label: string; changes: C[] }> = [];
  for (const run of runs) {
    const changes = run.changes.filter((change) => {
      if (change.status !== "pending" || seen.has(change.changeId)) return false;
      seen.add(change.changeId);
      return true;
    });
    if (changes.length > 0) {
      groups.push({ runId: run.runId, label: tidyRunGroupLabel(run, timeZone), changes });
    }
  }
  return groups;
}

/** Where the Memory screen keeps, on this device, when it was last opened. */
export const MEMORY_LAST_SEEN_KEY = "personal-memory-last-seen";

export function readMemoryLastSeen(): number | null {
  try {
    const raw = window.localStorage.getItem(MEMORY_LAST_SEEN_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeMemoryLastSeen(at: number): void {
  try {
    window.localStorage.setItem(MEMORY_LAST_SEEN_KEY, String(at));
  } catch {
    // Private mode: nothing is marked New next time.
  }
}

/**
 * A preference a bot saved since the screen was last opened here. Never on a
 * first visit (no stored time), so an existing list is not all marked New.
 */
export function isNewBotPreference(
  entry: Pick<PersonalMemoryEntry, "kind" | "source" | "createdAt">,
  lastSeenMs: number | null,
): boolean {
  return (
    lastSeenMs !== null &&
    entry.kind === "preference" &&
    entry.source.startsWith("bot:") &&
    DateTime.toEpochMillis(entry.createdAt) > lastSeenMs
  );
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
