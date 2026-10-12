/**
 * The one line the Bots page shows while the server is updating:
 * "Update 1.66.34 ready, installs when the bots are idle", "Backing up before
 * update", "Restarting for update", "Checking update 1.66.34", then
 * "Updated to 1.66.34" or "Update failed, still on 1.66.33".
 *
 * The words come from `GET /api/personal/update/status`
 * (apps/server/src/personal/updateStatus/updateStatusRoute.ts, which reads the
 * release runner's result file); this module owns how a phase reads, how long
 * it is worth showing and what the page says while the server is away for its
 * own restart. Pure except for the two small storage helpers, so every rule
 * here is unit-testable without a server.
 */

/** Must match PERSONAL_UPDATE_STATUS_PATH in apps/server updateStatusRoute.ts. */
export const UPDATE_STATUS_URL = "/api/personal/update/status";

/** How long one status request may take before the server counts as away. */
export const UPDATE_FETCH_TIMEOUT_MS = 5_000;

/** The answer's shape; a body that does not match it is no update at all. */
export interface UpdateStatusAnswer {
  readonly phase: string | null;
  readonly version: string | null;
  readonly previousVersion: string | null;
  readonly updatedAt: string | null;
}

export const NO_UPDATE: UpdateStatusAnswer = {
  phase: null,
  version: null,
  previousVersion: null,
  updatedAt: null,
};

const PHASE_TOKEN = /^[a-z_]{1,64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.-]{0,31}$/;

/**
 * Validates the server's answer. A phase this build does not know (a newer
 * server, a hand-made file) reads as text-less but still counts as an update
 * in progress, so the page keeps asking while it happens.
 */
export function parseUpdateStatusAnswer(value: unknown): UpdateStatusAnswer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const version = (candidate: unknown): string | null =>
    typeof candidate === "string" && VERSION.test(candidate) ? candidate : null;
  return {
    phase: typeof record.phase === "string" && PHASE_TOKEN.test(record.phase) ? record.phase : null,
    version: version(record.version),
    previousVersion: version(record.previousVersion),
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.length <= 40
        ? record.updatedAt
        : null,
  };
}

/** Asks the server where an update is; null when it cannot be asked. */
export async function fetchUpdateStatus(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = UPDATE_FETCH_TIMEOUT_MS,
): Promise<UpdateStatusAnswer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(UPDATE_STATUS_URL, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseUpdateStatusAnswer(await response.json()) ?? NO_UPDATE;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type UpdateTone = "plain" | "notice" | "problem";

export interface UpdateLine {
  /** The line itself. Always one line; the page truncates rather than wraps. */
  readonly text: string;
  readonly tone: UpdateTone;
  /** True when a tap may put it away before its own window ends. */
  readonly dismissible: boolean;
  /** Identity of this occurrence, for dismissal (phase + version + when). */
  readonly phase: string;
  readonly version: string | null;
}

const FINISHED_PHASES: ReadonlySet<string> = new Set([
  "live_verified",
  "live_verified_doc_update_failed",
  "rolled_back",
  "rollback_failed",
  "failed",
]);

/**
 * The line for one answer, or null when the phase gets none. `fallbackVersion`
 * is the version the page already shows (the server's own stamp), used for
 * "still on x" when the endpoint could not name the previous version.
 */
export function updateLineFor(
  answer: UpdateStatusAnswer,
  fallbackVersion: string | null = null,
): UpdateLine | null {
  const { phase } = answer;
  if (phase === null) return null;
  const version = answer.version;
  const line = (text: string, tone: UpdateTone): UpdateLine => ({
    text,
    tone,
    dismissible: FINISHED_PHASES.has(phase),
    phase,
    version,
  });
  switch (phase) {
    case "starting":
    case "guards":
    case "notes_check":
    case "evidence_check":
    case "preflight":
      return line(version === null ? "Preparing update" : `Preparing update ${version}`, "plain");
    case "waiting_for_idle":
      return line(
        version === null
          ? "Update ready, installs when the bots are idle"
          : `Update ${version} ready, installs when the bots are idle`,
        "notice",
      );
    case "backing_up":
      return line("Backing up before update", "plain");
    case "activating":
      return line("Restarting for update", "plain");
    case "smoking":
      return line(version === null ? "Checking update" : `Checking update ${version}`, "plain");
    case "live_verified":
    case "live_verified_doc_update_failed":
      return line(version === null ? "Updated" : `Updated to ${version}`, "plain");
    case "rolled_back": {
      const stillOn = answer.previousVersion ?? fallbackVersion;
      return line(
        stillOn === null
          ? "Update failed, rolled back to the previous version"
          : `Update failed, still on ${stillOn}`,
        "problem",
      );
    }
    case "rolling_back":
    case "rollback_failed":
    case "failed":
      return line("Update problem, the team is on it", "problem");
    default:
      return null;
  }
}

/**
 * A phase that means the server may go down for its own restart at any moment,
 * and how recently the page saw one for that reading to still stand. The
 * runner waits for idle, then backs up, then restarts: when the connection
 * dies right after any of those, the restart is what is happening.
 */
export const RESTART_EXPECTED_PHASES: ReadonlySet<string> = new Set([
  "waiting_for_idle",
  "backing_up",
  "activating",
  "rolling_back",
]);
export const RESTART_EXPECTED_WINDOW_MS = 30 * 60_000;
export const RESTARTING_TEXT = "Restarting for update";

export interface LastSeenPhase {
  readonly phase: string;
  readonly version: string | null;
  readonly atMs: number;
}

export interface DismissedLine {
  readonly phase: string;
  readonly version: string | null;
  readonly atMs: number;
}

export const DISMISSED_LINE_WINDOW_MS = 24 * 60 * 60_000;

/** What the page should show right now, or null for nothing. */
export function visibleUpdateLine(input: {
  readonly answer: UpdateStatusAnswer | null;
  /** True when the last request got no answer: the server is away. */
  readonly offline: boolean;
  readonly lastSeen: LastSeenPhase | null;
  readonly dismissed: DismissedLine | null;
  readonly fallbackVersion: string | null;
  readonly nowMs: number;
}): UpdateLine | null {
  if (input.offline) {
    // The server is not answering. If a restart was on its way, say so
    // instead of leaving the page with only the generic offline banner.
    const seen = input.lastSeen;
    if (
      seen !== null &&
      RESTART_EXPECTED_PHASES.has(seen.phase) &&
      input.nowMs - seen.atMs <= RESTART_EXPECTED_WINDOW_MS
    ) {
      return {
        text: RESTARTING_TEXT,
        tone: "plain",
        dismissible: false,
        phase: "restarting",
        version: seen.version,
      };
    }
    return null;
  }
  if (input.answer === null) return null;
  const line = updateLineFor(input.answer, input.fallbackVersion);
  if (line === null) return null;
  const dismissed = input.dismissed;
  if (
    dismissed !== null &&
    dismissed.phase === line.phase &&
    dismissed.version === line.version &&
    input.nowMs - dismissed.atMs < DISMISSED_LINE_WINDOW_MS
  ) {
    return null;
  }
  return line;
}

/** Where a dismissed line is remembered, per device. */
export const DISMISSED_LINE_KEY = "bots:update-status-dismissed";

/** The dismissed line, or null. localStorage, best-effort. */
export function readDismissedLine(): DismissedLine | null {
  try {
    const raw = window.localStorage.getItem(DISMISSED_LINE_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.phase !== "string" || record.phase.length > 64) return null;
    if (typeof record.atMs !== "number" || !Number.isFinite(record.atMs)) return null;
    return {
      phase: record.phase,
      version:
        typeof record.version === "string" && VERSION.test(record.version) ? record.version : null,
      atMs: record.atMs,
    };
  } catch {
    return null;
  }
}

export function writeDismissedLine(line: DismissedLine): void {
  try {
    window.localStorage.setItem(DISMISSED_LINE_KEY, JSON.stringify(line));
  } catch {
    // Private mode: the line simply comes back on the next launch.
  }
}

/** "v1.66.33" as the page's stamp prints it -> "1.66.33", else null. */
export function versionFromLabel(label: string | null): string | null {
  if (label === null) return null;
  const text = label.startsWith("v") ? label.slice(1) : label;
  return /^\d+(?:\.\d+)+$/.test(text) ? text : null;
}
