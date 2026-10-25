// @effect-diagnostics nodeBuiltinImport:off - the mapping is read from the process environment, like other migrations' settings.
/**
 * Rewrites the absolute Windows paths stored in the database to their Linux
 * equivalents, once, while the data root is moved from Windows to Omarchy.
 *
 * Why this exists: projects, worktrees and the event log hold absolute paths
 * (`C:/Claude/AI/...`, `C:/Users/Ht/...`). On Linux every one of them is dead,
 * so a project cannot be opened and a thread's worktree points nowhere.
 *
 * The mapping is configuration, not a guess:
 *
 *   T3CODE_PATH_MAP="C:/Users/Ht=/home/harout;C:/Claude/AI=/home/harout/claude"
 *
 * The longest matching prefix wins (so a specific mapping beats a broader one),
 * matching ignores the case of the prefix and accepts either slash, and the
 * remainder is kept and normalised to forward slashes. With the variable unset
 * the migration does nothing - which is what Windows runs, so the shipping
 * Windows install is untouched.
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
 *   - orchestration_events.payload_json: workspaceRoot, worktreePath,
 *     faviconPath, projectCwd (structured keys only, never message text)
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const PATH_MAP_ENV = "T3CODE_PATH_MAP";

/** The JSON payload keys that hold a path. Everything else is content. */
const EVENT_PATH_KEYS = ["workspaceRoot", "worktreePath", "faviconPath", "projectCwd"] as const;

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

    yield* sql`
      UPDATE projection_projects
      SET workspace_root = ${to} || substr(workspace_root, ${length + 1})
      WHERE lower(substr(workspace_root, 1, ${length})) = lower(${from})
        AND (length(workspace_root) = ${length}
          OR substr(workspace_root, ${length + 1}, 1) IN ('/', '\\'))
    `;

    yield* sql`
      UPDATE projection_projects
      SET favicon_path = ${to} || substr(favicon_path, ${length + 1})
      WHERE favicon_path IS NOT NULL
        AND lower(substr(favicon_path, 1, ${length})) = lower(${from})
        AND (length(favicon_path) = ${length}
          OR substr(favicon_path, ${length + 1}, 1) IN ('/', '\\'))
    `;

    yield* sql`
      UPDATE projection_threads
      SET worktree_path = ${to} || substr(worktree_path, ${length + 1})
      WHERE worktree_path IS NOT NULL
        AND lower(substr(worktree_path, 1, ${length})) = lower(${from})
        AND (length(worktree_path) = ${length}
          OR substr(worktree_path, ${length + 1}, 1) IN ('/', '\\'))
    `;

    for (const key of EVENT_PATH_KEYS) {
      // json_set keeps the rest of the payload untouched, so message text is
      // never rewritten; only these four structural keys are paths.
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(
          payload_json,
          ${`$.${key}`},
          ${to} || substr(json_extract(payload_json, ${`$.${key}`}), ${length + 1})
        )
        WHERE json_type(payload_json, ${`$.${key}`}) = 'text'
          AND lower(substr(json_extract(payload_json, ${`$.${key}`}), 1, ${length})) =
            lower(${from})
          AND (length(json_extract(payload_json, ${`$.${key}`})) = ${length}
            OR substr(json_extract(payload_json, ${`$.${key}`}), ${length + 1}, 1) IN ('/', '\\'))
      `;
    }
  }

  // A rewritten value may still carry the Windows separator in its remainder;
  // a POSIX path never contains a backslash, so this is safe.
  yield* sql`
    UPDATE projection_projects SET workspace_root = replace(workspace_root, '\\', '/')
    WHERE substr(workspace_root, 1, 1) = '/' AND instr(workspace_root, '\') > 0
  `;
  yield* sql`
    UPDATE projection_projects SET favicon_path = replace(favicon_path, '\\', '/')
    WHERE favicon_path IS NOT NULL AND substr(favicon_path, 1, 1) = '/'
      AND instr(favicon_path, '\') > 0
  `;
  yield* sql`
    UPDATE projection_threads SET worktree_path = replace(worktree_path, '\\', '/')
    WHERE worktree_path IS NOT NULL AND substr(worktree_path, 1, 1) = '/'
      AND instr(worktree_path, '\') > 0
  `;
  for (const key of EVENT_PATH_KEYS) {
    yield* sql`
      UPDATE orchestration_events
      SET payload_json = json_set(
        payload_json,
        ${`$.${key}`},
        replace(json_extract(payload_json, ${`$.${key}`}), '\\', '/')
      )
      WHERE json_type(payload_json, ${`$.${key}`}) = 'text'
        AND substr(json_extract(payload_json, ${`$.${key}`}), 1, 1) = '/'
        AND instr(json_extract(payload_json, ${`$.${key}`}), '\') > 0
    `;
  }

  yield* Effect.logInfo(
    `Rewrote stored Windows paths for ${mappings.length} mapping(s).`,
  );
});
