/**
 * What a person is told while the hbots server updates itself: preparing,
 * waiting for the bots (and for whom), restarting, checking, done or failed.
 * The facts come from `GET /api/personal/update/status`. Pure, so web and
 * phone say the same words.
 */

export const SERVER_UPDATE_PATH = "/api/personal/update/status";

export interface ServerUpdateWaiting {
  readonly sinceMs: number | null;
  readonly busyThreadIds: ReadonlyArray<string>;
  readonly buildRunning: boolean;
  readonly quietLooks: number;
}

export interface ServerUpdate {
  readonly phase: string | null;
  readonly version: string | null;
  readonly previousVersion: string | null;
  readonly updatedAtMs: number | null;
  readonly waiting: ServerUpdateWaiting | null;
}

const PHASE_TOKEN = /^[a-z_]{1,64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;
const THREAD_ID = /^[0-9a-f-]{36}$/;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const timeOf = (value: unknown): number | null => {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

function parseWaiting(value: unknown): ServerUpdateWaiting | null {
  const waiting = record(value);
  if (waiting === null) return null;
  const busy = Array.isArray(waiting.busyThreadIds) ? waiting.busyThreadIds : [];
  return {
    sinceMs: timeOf(waiting.since),
    busyThreadIds: busy
      .filter((id): id is string => typeof id === "string" && THREAD_ID.test(id))
      .slice(0, 8),
    buildRunning: waiting.buildRunning === true,
    quietLooks: typeof waiting.quietLooks === "number" ? waiting.quietLooks : 0,
  };
}

/** Validates the server's answer; null when it is not an answer at all. */
export function parseServerUpdate(value: unknown): ServerUpdate | null {
  const body = record(value);
  if (body === null) return null;
  const version = (candidate: unknown): string | null =>
    typeof candidate === "string" && VERSION.test(candidate) ? candidate : null;
  return {
    phase: typeof body.phase === "string" && PHASE_TOKEN.test(body.phase) ? body.phase : null,
    version: version(body.version),
    previousVersion: version(body.previousVersion),
    updatedAtMs: timeOf(body.updatedAt),
    waiting: parseWaiting(body.waiting),
  };
}

export type ServerUpdateTone = "plain" | "notice" | "problem";

export interface ServerUpdateLines {
  readonly title: string;
  /** A second, quieter line: who is busy, or how long is left. */
  readonly detail: string | null;
  readonly tone: ServerUpdateTone;
}

const minutes = (elapsedMs: number): string => {
  const whole = Math.floor(Math.max(0, elapsedMs) / 60_000);
  if (whole < 1) return "under 1 min";
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h ${String(whole % 60).padStart(2, "0")} min`;
};

function waitingDetail(
  waiting: ServerUpdateWaiting | null,
  nowMs: number,
  nameOfThread: (threadId: string) => string | null,
): string {
  const waited = waiting?.sinceMs == null ? null : `Waiting ${minutes(nowMs - waiting.sinceMs)}.`;
  const join = (first: string) => (waited === null ? first : `${first} ${waited}`);
  if (waiting === null) return "It restarts once every bot is idle.";
  const names = [
    ...new Set(waiting.busyThreadIds.flatMap((threadId) => nameOfThread(threadId) ?? [])),
  ];
  const unnamed = waiting.busyThreadIds.length > 0 && names.length === 0;
  if (names.length > 0) return join(`Busy now: ${names.slice(0, 3).join(", ")}.`);
  if (unnamed) return join("A bot is still working.");
  if (waiting.buildRunning) return join("A build is running.");
  if (waiting.quietLooks > 0) return join("All quiet. Restarting shortly.");
  return waited ?? "It restarts once every bot is idle.";
}

/**
 * The words for one answer, or null when there is nothing to say. `stillOn`
 * is the version the screen already shows, for "still on x" after a rollback.
 */
export function serverUpdateLines(input: {
  readonly update: ServerUpdate;
  readonly nowMs: number;
  readonly nameOfThread?: ((threadId: string) => string | null) | undefined;
  readonly stillOn?: string | null | undefined;
}): ServerUpdateLines | null {
  const { update } = input;
  const version = update.version;
  const named = (text: string) => (version === null ? text : `${text} ${version}`);
  switch (update.phase) {
    case "starting":
    case "guards":
    case "notes_check":
    case "evidence_check":
    case "preflight":
      return { title: named("Preparing update"), detail: null, tone: "plain" };
    case "waiting_for_idle":
      return {
        title:
          version === null
            ? "Update is waiting for the bots to finish"
            : `Update ${version} is waiting for the bots to finish`,
        detail: waitingDetail(update.waiting, input.nowMs, input.nameOfThread ?? (() => null)),
        tone: "notice",
      };
    case "backing_up":
      return { title: named("Backing up before update"), detail: null, tone: "plain" };
    case "activating":
      return SERVER_RESTARTING_LINES;
    case "smoking":
      return {
        title: named("Checking update"),
        detail: "The server is back. Checks take about 2 min.",
        tone: "plain",
      };
    case "live_verified":
    case "live_verified_doc_update_failed":
      return {
        title: version === null ? "Updated" : `Updated to ${version}`,
        detail: null,
        tone: "plain",
      };
    case "rolled_back": {
      const stillOn = update.previousVersion ?? input.stillOn ?? null;
      return {
        title:
          stillOn === null
            ? "Update failed, rolled back to the previous version"
            : `Update failed, still on ${stillOn}`,
        detail: null,
        tone: "problem",
      };
    }
    case "rolling_back":
    case "rollback_failed":
    case "failed":
      return { title: "Update problem, the team is on it", detail: null, tone: "problem" };
    default:
      return null;
  }
}

/** While the server is away for its own restart. */
export const SERVER_RESTARTING_LINES: ServerUpdateLines = {
  title: "Restarting the server for the update",
  detail: "Back in about a minute.",
  tone: "plain",
};

/** The server may go down for its restart at any moment in these phases. */
const RESTART_EXPECTED: ReadonlySet<string> = new Set([
  "waiting_for_idle",
  "backing_up",
  "activating",
  "rolling_back",
]);
const RESTART_EXPECTED_WINDOW_MS = 30 * 60_000;
/** Still away this long after the last answer means something is wrong: say nothing calm. */
const RESTART_GRACE_MS = 5 * 60_000;

const FINISHED: ReadonlySet<string> = new Set(["live_verified", "live_verified_doc_update_failed"]);
/** How long "Updated to x" stands once this device has shown it (Harout, 13 Nov: 10 s is enough). */
export const UPDATED_SHOWN_MS = 10_000;

/**
 * What to show now. `update` is the last answer, `answeredAtMs` when it came,
 * and `reachable` whether the newest request got one.
 */
export function visibleServerUpdate(input: {
  readonly update: ServerUpdate | null;
  readonly answeredAtMs: number | null;
  readonly reachable: boolean;
  readonly nowMs: number;
  readonly nameOfThread?: ((threadId: string) => string | null) | undefined;
  readonly stillOn?: string | null | undefined;
  /** When this device first showed the finished line for this version; null if it has not. */
  readonly updatedFirstShownMs?: number | null | undefined;
}): ServerUpdateLines | null {
  const { update } = input;
  if (update === null || update.phase === null) return null;
  if (!input.reachable) {
    const age = input.answeredAtMs === null ? Infinity : input.nowMs - input.answeredAtMs;
    const expected =
      RESTART_EXPECTED.has(update.phase) &&
      update.updatedAtMs !== null &&
      input.nowMs - update.updatedAtMs <= RESTART_EXPECTED_WINDOW_MS;
    return expected && age <= RESTART_GRACE_MS ? SERVER_RESTARTING_LINES : null;
  }
  const firstShown = input.updatedFirstShownMs ?? null;
  if (
    FINISHED.has(update.phase) &&
    firstShown !== null &&
    input.nowMs - firstShown >= UPDATED_SHOWN_MS
  ) {
    return null;
  }
  return serverUpdateLines({
    update,
    nowMs: input.nowMs,
    nameOfThread: input.nameOfThread,
    stillOn: input.stillOn,
  });
}

/** How soon to ask again: often while an update is under way, rarely otherwise. */
export function serverUpdatePollMs(update: ServerUpdate | null, reachable: boolean): number {
  if (!reachable) return 5_000;
  if (update === null || update.phase === null || FINISHED.has(update.phase)) return 60_000;
  return 10_000;
}

/** True for the phases whose line is the short "Updated to x" note. */
export const isServerUpdateFinished = (update: ServerUpdate | null): boolean =>
  update !== null && update.phase !== null && FINISHED.has(update.phase);
