/**
 * Where a Bots release is right now, for the one-line status on the Bots page
 * (web features/personal/UpdateStatusLine.tsx).
 *
 * The release runner rewrites `<home>\run\restart-<version>-result.json`
 * (UTF-8 with BOM) as it moves through its steps: starting, guards, then
 * notes_check, evidence_check, preflight, waiting_for_idle (up to 48 h),
 * backing_up, activating, smoking, and finally live_verified - or, on a bad
 * landing, rolling_back -> rolled_back / rollback_failed, or failed. A waiter
 * replaced before activation writes superseded_before_activation instead.
 * `-dryrun-`, `-prepare-` and `-guards-` result files share the folder and are
 * NOT runs: their names carry a hyphen after the version, so the name pattern
 * below never matches them.
 *
 * The module is pure and clock-free (the caller passes `nowMs`) so the rules
 * about which phases show, and for how long, are unit-testable on their own;
 * the route (updateStatusRoute.ts) owns the filesystem and the cache.
 */
import * as DateTime from "effect/DateTime";
import type * as Path from "effect/Path";

/** `restart-1.66.34-result.json`; a version is dotted digits, nothing else. */
const RESTART_RESULT_NAME = /^restart-(\d+(?:\.\d+)*)-result\.json$/;
const VERSION = /^\d+(?:\.\d+)*$/;

/**
 * Files older than this are history, not an update: the same window the
 * release tools use when they look back at what happened.
 */
export const RESTART_RESULT_MAX_AGE_MS = 48 * 60 * 60_000;

/**
 * A finished update (updated / rolled back / failed) is worth a line for
 * about ten minutes, then the page goes quiet again.
 */
export const FINISHED_PHASE_WINDOW_MS = 10 * 60_000;

/**
 * A run-in-progress phase whose file has not moved for two hours is not
 * progress any more (a runner killed mid-run leaves its last phase behind).
 * `waiting_for_idle` is exempt: the idle gate may legitimately sit for up to
 * 48 h, and the file window above is its bound.
 */
export const PROGRESS_PHASE_STALE_MS = 2 * 60 * 60_000;

/** The data roots that live beside the shared run folder (scripts/personal/common.ps1). */
const LIVE_DATA_ROOT_NAMES = new Set(["dev", "prod"]);

/**
 * The release tools' run folder for a server running on `baseDir`:
 * `%USERPROFILE%\.personal-bots\run` for the live "dev"/"prod" roots (which sit
 * beside it), and `run\` inside the root itself for a throwaway test server,
 * whose whole root is its own home.
 */
export function personalRunDir(baseDir: string, path: Path.Path): string {
  return LIVE_DATA_ROOT_NAMES.has(path.basename(baseDir).toLowerCase())
    ? path.join(path.dirname(baseDir), "run")
    : path.join(baseDir, "run");
}

/** The release version a restart result file is about, or null if it is not one. */
export function restartResultVersion(fileName: string): string | null {
  return RESTART_RESULT_NAME.exec(fileName)?.[1] ?? null;
}

/**
 * Compares two dotted versions numerically ("1.66.9" < "1.66.10"). Used only
 * to break an mtime tie: file info carries mtime as a `Date`, so two result
 * files written inside the same millisecond report the same time, and the
 * higher version was the one written later in that millisecond.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Every status the release runner writes in a real run (run/hbots-release.ps1),
 * plus the one the old waiters wrote for a superseded waiter. A status outside
 * this set is a file this build does not understand and shows nothing.
 */
export const RESTART_STATUSES = [
  "starting",
  "guards",
  "notes_check",
  "evidence_check",
  "preflight",
  "waiting_for_idle",
  "backing_up",
  "activating",
  "smoking",
  "live_verified",
  "live_verified_doc_update_failed",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
  "failed",
  "superseded_before_activation",
] as const;

export type RestartStatus = (typeof RESTART_STATUSES)[number];

/** The statuses that mean an update finished, one way or another. */
const FINISHED_STATUSES: ReadonlySet<RestartStatus> = new Set([
  "live_verified",
  "live_verified_doc_update_failed",
  "rolling_back",
  "rolled_back",
  "rollback_failed",
  "failed",
]);

const KNOWN_STATUSES: ReadonlySet<string> = new Set(RESTART_STATUSES);

export function restartStatusOf(value: unknown): RestartStatus | null {
  return typeof value === "string" && KNOWN_STATUSES.has(value) ? (value as RestartStatus) : null;
}

/** What one restart result file says: its status and the version it is about. */
export interface RestartResult {
  readonly status: RestartStatus | null;
  readonly version: string | null;
}

/**
 * Parses a restart result file. Tolerates the BOM the runner writes. Null when
 * the bytes are not an object at all; a file with an unknown status still
 * parses (status null) so its version can serve as the filename's fallback.
 */
export function readRestartResult(text: string): RestartResult | null {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const version = record.version;
  return {
    status: restartStatusOf(record.status),
    version: typeof version === "string" && VERSION.test(version) ? version : null,
  };
}

/**
 * What the page polls for. `previousVersion` is the version this server is
 * running (its own version.txt): the one an update is replacing, and exactly
 * "still on" after a rollback.
 */
export interface UpdateStatusView {
  readonly phase: RestartStatus;
  readonly version: string | null;
  readonly previousVersion: string | null;
  readonly updatedAt: string;
}

/**
 * The status to show, or null for nothing. `updatedAtMs` is the result file's
 * mtime: every phase change rewrites the file, so its mtime is when the phase
 * was reached.
 */
export function updateStatusView(input: {
  readonly status: RestartStatus | null;
  readonly version: string | null;
  readonly liveVersion: string | null;
  readonly updatedAtMs: number;
  readonly nowMs: number;
}): UpdateStatusView | null {
  const { status } = input;
  if (status === null || status === "superseded_before_activation") return null;
  // A file stamped in the future (clock skew between the writer and the
  // server) is treated as just written, not as ancient or as an error.
  const ageMs = Math.max(0, input.nowMs - input.updatedAtMs);
  if (ageMs > RESTART_RESULT_MAX_AGE_MS) return null;
  if (FINISHED_STATUSES.has(status)) {
    if (ageMs > FINISHED_PHASE_WINDOW_MS) return null;
  } else if (status !== "waiting_for_idle" && ageMs > PROGRESS_PHASE_STALE_MS) {
    return null;
  }
  return {
    phase: status,
    version: input.version,
    previousVersion: input.liveVersion,
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(input.updatedAtMs)),
  };
}
