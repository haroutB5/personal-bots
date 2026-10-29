// @effect-diagnostics nodeBuiltinImport:off - the mapping is read from the process environment, like migration 113.
/**
 * Rewrites the Windows paths inside the text bots are given as instructions,
 * once, while the data root is moved from Windows to Omarchy.
 *
 * Why this exists: migration 113 moved the *structural* paths (projects,
 * worktrees, the event log) but deliberately left text alone. Bot personas
 * still said "read C:/Claude/AI/dev-team/HANDBOOK.md", so every bot on the
 * Linux laptop was told to read a file that does not exist, and routine
 * prompts and saved memory entries named `C:/Claude/AI/...` or
 * `C:/Users/Ht/...` the same way. The handbook, the app sheets, the published
 * pages and every repo now live under `/home/harout/...`.
 *
 * The same `T3CODE_PATH_MAP` configuration as 113 is used, so nothing is
 * guessed: with the variable unset (the shipping Windows install) this
 * migration is a no-op, and it never rewrites a path it was not told about.
 * Unlike 113 it never fails a boot: a persona with a stale path is a wrong
 * instruction, not an unusable database.
 *
 * Only text that is *instructions to a bot* is touched:
 *   - personal_bots.instructions
 *   - personal_routines.prompt
 *   - personal_memory.content (notes and preferences bots are handed as facts)
 *
 * A path may sit mid-sentence, so the rewrite works on occurrences rather than
 * whole values, and only the path token after the mapped prefix has its
 * backslashes turned into slashes; the prose around it is untouched.
 * Idempotent: after the rewrite no occurrence of a mapped Windows prefix is
 * left, and a second run changes nothing.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { parsePathMap, type PathMapping } from "./113_LinuxPathRewrite.ts";

const PATH_MAP_ENV = "T3CODE_PATH_MAP";

/** The characters that end a path token: whitespace, quotes, brackets, shell pipes. */
const PATH_TAIL = String.raw`([^\s"'\x60<>|)\]]*)`;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One occurrence matcher per mapping: the prefix, in either separator style
 * and any case, not followed by another path character, then the rest of the
 * path token. `C:/Claude/AIx` is a different folder and never matches.
 */
export function instructionRewritePattern(mapping: PathMapping): RegExp {
  const prefix = mapping.from
    .split("/")
    .map(escapeRegExp)
    .join(String.raw`[\\/]`);
  return new RegExp(`${prefix}(?![A-Za-z0-9_])${PATH_TAIL}`, "gi");
}

/**
 * The rewritten text, or null when nothing changed. Longest prefix first, so a
 * specific mapping (`C:/Claude/AI`) beats a broader one (`C:/Claude`).
 */
export function rewriteInstructionText(
  text: string,
  mappings: ReadonlyArray<PathMapping>,
): string | null {
  let result = text;
  for (const mapping of [...mappings].sort((a, b) => b.from.length - a.from.length)) {
    const pattern = instructionRewritePattern(mapping);
    result = result.replace(
      pattern,
      (_match, tail: string) => `${mapping.to}${tail.replaceAll("\\", "/")}`,
    );
  }
  return result === text ? null : result;
}

/** A column of instruction text: the table it lives in and its id column. */
const TARGETS = [
  { table: "personal_bots", id: "bot_id", column: "instructions" },
  { table: "personal_routines", id: "routine_id", column: "prompt" },
  { table: "personal_memory", id: "memory_id", column: "content" },
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mappings = parsePathMap(process.env[PATH_MAP_ENV]);
  if (mappings.length === 0) {
    yield* Effect.logDebug(`${PATH_MAP_ENV} is not set; no instruction paths rewritten.`);
    return;
  }

  let rewritten = 0;
  for (const target of TARGETS) {
    // Only rows that could hold a Windows path are read; the tables are small
    // (bots are dozens, memory a few thousand rows), and LIKE is case
    // insensitive for ASCII, so `c:/...` is found too.
    const rows = yield* sql<{ readonly id: string; readonly value: string }>`
      SELECT ${sql.unsafe(target.id)} AS id, ${sql.unsafe(target.column)} AS value
      FROM ${sql.unsafe(target.table)}
      WHERE ${sql.unsafe(target.column)} LIKE '%C:%'
    `.pipe(
      Effect.orElseSucceed(
        (): ReadonlyArray<{ readonly id: string; readonly value: string }> => [],
      ),
    );
    for (const row of rows) {
      const next = rewriteInstructionText(row.value, mappings);
      if (next === null) continue;
      yield* sql`
        UPDATE ${sql.unsafe(target.table)}
        SET ${sql.unsafe(target.column)} = ${next}
        WHERE ${sql.unsafe(target.id)} = ${row.id}
      `;
      rewritten += 1;
    }
  }

  yield* Effect.logInfo(
    `Rewrote Windows paths in bot instructions, routine prompts and memory for ${mappings.length} mapping(s) (${rewritten} row(s)).`,
  );
});
