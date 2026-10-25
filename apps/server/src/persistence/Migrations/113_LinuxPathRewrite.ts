// @effect-diagnostics nodeBuiltinImport:off - the mapping is read from the process environment, like other migrations' settings.
/**
 * Rewrites the absolute Windows paths stored in the database to their Linux
 * equivalents, once, while the data root is moved from Windows to Omarchy.
 *
 * Why this exists: projects, worktrees and the event log hold absolute paths
 * (`C:/Claude/AI/...`, `C:/Users/Ht/...`, often with backslashes). On Linux
 * every one of them is dead, so a project cannot be opened and a thread's
 * worktree points nowhere.
 *
 * The mapping is configuration, not a guess:
 *
 *   T3CODE_PATH_MAP="C:/Users/Ht=/home/harout;C:/Claude/AI=/home/harout/claude"
 *
 * The longest matching prefix wins (so a specific mapping beats a broader one),
 * matching ignores the case of the prefix and treats `\` and `/` alike, and the
 * remainder is kept, normalised to `/`. With the variable unset the migration
 * does nothing - which is what Windows runs, so the shipping Windows install is
 * untouched.
 *
 * Idempotent: after the rewrite no stored value starts with a mapped prefix,
 * so a second run (or a re-run after a failed boot) changes nothing.
 *
 * Reversal: one-way in place. To go back to Windows, restore the data root copy
 * taken before the move (prewipe image / data-root copy); the migration then
 * never runs again because it is already recorded. Nothing is deleted: only the
 * prefix of a path value is replaced.
 *
 * Touched storage:
 *   - projection_projects.workspace_root, favicon_path
 *   - projection_threads.worktree_path
 *   - orchestration_events.payload_json: workspaceRoot, worktreePath and
 *     faviconPath on project/thread create and meta-update events only
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PATH_MAP_ENV = "T3CODE_PATH_MAP";

/**
 * The only event payloads that hold a path. Every other event (messages, tool
 * output, titles) is content and must not be rewritten. Restricting to these
 * types keeps the migration off a 1.25M-row JSON scan: on the live database the
 * set is a few thousand rows, and each is parsed once.
 */
const EVENT_PATH_KEYS = ["workspaceRoot", "worktreePath", "faviconPath"] as const;

/** `char(92)` is a backslash, spelled this way so no SQL/TS escaping can mangle it. */
const SLASH = "char(92)";

export interface PathMapping {
  /** Normalised prefix, forward slashes, no trailing slash (e.g. `C:/Users/Ht`). */
  readonly from: string;
  /** Normalised replacement, forward slashes, no trailing slash. */
  readonly to: string;
}

const normalise = (value: string): string => value.trim().replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * `from=to;from=to`, longest prefix first. A malformed entry is skipped rather
 * than failing a boot: a bad mapping must never make the server unbootable.
 */
export function parsePathMap(raw: string | undefined): ReadonlyArray<PathMapping> {
  if (raw === undefined || raw.trim() === "") return [];
  const mappings: PathMapping[] = [];
  for (const entry of raw.split(";")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const from = normalise(entry.slice(0, separator));
    const to = normalise(entry.slice(separator + 1));
    if (from === "" || to === "" || from.toLowerCase() === to.toLowerCase()) continue;
    // Only Windows absolute paths are rewritten; a Linux path is already home.
    if (!/^[A-Za-z]:\//.test(from)) continue;
    mappings.push({ from, to });
  }
  return mappings.sort((a, b) => b.from.length - a.from.length);
}

/**
 * A stored path under a mapped prefix becomes the target prefix plus the
 * remainder, with every separator normalised. Anything else is returned
 * untouched, including a path that only shares a partial segment
 * (`C:/Users/Htx` is not under `C:/Users/Ht`).
 */
export function rewriteStoredPath(
  value: string,
  mappings: ReadonlyArray<PathMapping>,
): string | null {
  const slashy = value.replace(/\\/g, "/");
  for (const { from, to } of mappings) {
    if (slashy.length < from.length) continue;
    if (slashy.slice(0, from.length).toLowerCase() !== from.toLowerCase()) continue;
    const boundary = slashy.slice(from.length, from.length + 1);
    if (boundary !== "" && boundary !== "/") continue;
    return `${to}${slashy.slice(from.length)}`;
  }
  return null;
}

/** Rewrites every path-valued key of one event payload; returns null if unchanged. */
export function rewriteEventPayload(
  payloadJson: string,
  mappings: ReadonlyArray<PathMapping>,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  let changed = false;
  for (const key of EVENT_PATH_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const rewritten = rewriteStoredPath(value, mappings);
    if (rewritten !== null) {
      record[key] = rewritten;
      changed = true;
    }
  }
  return changed ? JSON.stringify(record) : null;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mappings = parsePathMap(process.env[PATH_MAP_ENV]);
  if (mappings.length === 0) {
    // Windows is the expected no-op. On Linux, a missing mapping means the
    // data root was moved without translating its paths: say so loudly, once,
    // because this migration will not run again.
    const message = `${PATH_MAP_ENV} is not set; no stored paths rewritten.`;
    yield* process.platform === "linux" ? Effect.logWarning(message) : Effect.logDebug(message);
    return;
  }

  for (const { from, to } of mappings) {
    const length = from.length;

    // Every statement repeats the same three-part match: the prefix, with
    // backslashes read as slashes and the case folded, then a boundary.
    yield* sql`
      UPDATE projection_projects
      SET workspace_root = ${to} || replace(substr(workspace_root, ${length + 1}), ${sql.unsafe(SLASH)}, '/')
      WHERE lower(replace(substr(workspace_root, 1, ${length}), ${sql.unsafe(SLASH)}, '/')) = lower(${from})
        AND (length(workspace_root) = ${length}
          OR substr(workspace_root, ${length + 1}, 1) IN ('/', ${sql.unsafe(SLASH)}))
    `;

    yield* sql`
      UPDATE projection_projects
      SET favicon_path = ${to} || replace(substr(favicon_path, ${length + 1}), ${sql.unsafe(SLASH)}, '/')
      WHERE favicon_path IS NOT NULL
        AND lower(replace(substr(favicon_path, 1, ${length}), ${sql.unsafe(SLASH)}, '/')) = lower(${from})
        AND (length(favicon_path) = ${length}
          OR substr(favicon_path, ${length + 1}, 1) IN ('/', ${sql.unsafe(SLASH)}))
    `;

    yield* sql`
      UPDATE projection_threads
      SET worktree_path = ${to} || replace(substr(worktree_path, ${length + 1}), ${sql.unsafe(SLASH)}, '/')
      WHERE worktree_path IS NOT NULL
        AND lower(replace(substr(worktree_path, 1, ${length}), ${sql.unsafe(SLASH)}, '/')) = lower(${from})
        AND (length(worktree_path) = ${length}
          OR substr(worktree_path, ${length + 1}, 1) IN ('/', ${sql.unsafe(SLASH)}))
    `;
  }

  // The event log is 1.25M rows on the live database, and reading every payload
  // cost 169 s in a `LIKE` scan. Only these four event types can carry a path,
  // so only they are read, and the keys are rewritten in TypeScript instead of
  // in SQL: one pass over a few thousand rows.
  const events = yield* sql<{ readonly sequence: number; readonly payload_json: string }>`
    SELECT sequence, payload_json FROM orchestration_events
    WHERE event_type IN ('project.created', 'project.meta-updated', 'thread.created', 'thread.meta-updated')
  `.pipe(Effect.orElseSucceed(() => []));
  let rewrittenEvents = 0;
  for (const event of events) {
    const rewritten = rewriteEventPayload(event.payload_json, mappings);
    if (rewritten === null) continue;
    yield* sql`
      UPDATE orchestration_events SET payload_json = ${rewritten} WHERE sequence = ${event.sequence}
    `;
    rewrittenEvents += 1;
  }

  // A value that was already under a target root but still carries Windows
  // separators is cleaned up too; a POSIX path never contains a backslash.
  yield* sql`
    UPDATE projection_projects SET workspace_root = replace(workspace_root, ${sql.unsafe(SLASH)}, '/')
    WHERE substr(workspace_root, 1, 1) = '/' AND instr(workspace_root, ${sql.unsafe(SLASH)}) > 0
  `;
  yield* sql`
    UPDATE projection_projects SET favicon_path = replace(favicon_path, ${sql.unsafe(SLASH)}, '/')
    WHERE favicon_path IS NOT NULL AND substr(favicon_path, 1, 1) = '/'
      AND instr(favicon_path, ${sql.unsafe(SLASH)}) > 0
  `;
  yield* sql`
    UPDATE projection_threads SET worktree_path = replace(worktree_path, ${sql.unsafe(SLASH)}, '/')
    WHERE worktree_path IS NOT NULL AND substr(worktree_path, 1, 1) = '/'
      AND instr(worktree_path, ${sql.unsafe(SLASH)}) > 0
  `;

  yield* Effect.logInfo(
    `Rewrote stored Windows paths for ${mappings.length} mapping(s) (${rewrittenEvents} event(s), ${events.length} scanned).`,
  );
});
