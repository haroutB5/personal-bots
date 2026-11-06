// Ledger check: the v2 port must not lose a hook silently.
//
//   node scripts/personal/sync/ledger-check.mjs [--file <ledger.tsv>] [--patches <dir>] [--no-open-at <PR>]
//
// Columns: path  origin  kind  ourLines  targetPR  status  reason
//   origin a rename's source path, empty when it equals path
//   kind   modify-delete | content | added-broken
//   status open | done | dropped
//
// Fails when a row has no target PR, when a dropped row has no reason, and on
// any structural damage (bad column count, unknown kind or status, duplicate
// path, non-integer line count). With --patches, every row must have
// <dir>/<path>.patch so the parked hunk is reviewable. With --no-open-at, a row
// whose target names that PR must be closed at merge time.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const DEFAULT_LEDGER_PATH = NodePath.join(HERE, "v2-port-ledger", "ledger.tsv");
export const LEDGER_HEADER = ["path", "origin", "kind", "ourLines", "targetPR", "status", "reason"];
export const LEDGER_KINDS = new Set(["modify-delete", "content", "added-broken"]);
export const LEDGER_STATUSES = new Set(["open", "done", "dropped"]);

/**
 * Parse and validate one ledger body. Returns `{rows, errors}`; the caller
 * decides whether a row count of zero is acceptable.
 */
export const checkLedgerText = (text) => {
  const errors = [];
  const rows = [];
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return { rows, errors: ["ledger is empty (a header row is required)"] };
  }
  const header = lines[0].split("\t");
  if (
    header.length !== LEDGER_HEADER.length ||
    !LEDGER_HEADER.every((name, index) => header[index] === name)
  ) {
    errors.push(`header must be: ${LEDGER_HEADER.join("\t")}`);
    return { rows, errors };
  }
  const seen = new Set();
  for (let index = 1; index < lines.length; index += 1) {
    const columns = lines[index].split("\t");
    const lineNumber = index + 1;
    if (columns.length !== LEDGER_HEADER.length) {
      errors.push(
        `line ${lineNumber}: expected ${LEDGER_HEADER.length} columns, got ${columns.length}`,
      );
      continue;
    }
    const [path, origin, kind, ourLinesText, targetPR, status, reason] = columns;
    const row = {
      path,
      origin,
      kind,
      ourLines: ourLinesText,
      targetPR,
      status,
      reason,
      lineNumber,
    };
    rows.push(row);
    if (!path) {
      errors.push(`line ${lineNumber}: path is empty`);
    } else if (seen.has(path)) {
      errors.push(`line ${lineNumber}: duplicate path ${path}`);
    }
    seen.add(path);
    if (!LEDGER_KINDS.has(kind)) {
      errors.push(
        `line ${lineNumber}: kind must be one of ${[...LEDGER_KINDS].join(", ")}, got ${JSON.stringify(kind)}`,
      );
    }
    if (!/^\d+$/.test(ourLinesText)) {
      errors.push(
        `line ${lineNumber}: ourLines must be a non-negative integer, got ${JSON.stringify(ourLinesText)}`,
      );
    }
    if (!LEDGER_STATUSES.has(status)) {
      errors.push(
        `line ${lineNumber}: status must be one of ${[...LEDGER_STATUSES].join(", ")}, got ${JSON.stringify(status)}`,
      );
    }
    if (!targetPR) {
      errors.push(`line ${lineNumber}: ${path || "(no path)"} has no target PR`);
    }
    if (status === "dropped" && !reason.trim()) {
      errors.push(`line ${lineNumber}: ${path || "(no path)"} is dropped without a reason`);
    }
  }
  return { rows, errors };
};

export const missingPatches = (rows, patchesDir) =>
  rows
    .filter((row) => !NodeFS.existsSync(NodePath.join(patchesDir, `${row.path}.patch`)))
    .map((row) => row.path);

/** Rows a merge target must close: target names the PR and status is still open. */
export const openAtErrors = (rows, targetPR) =>
  rows
    .filter((row) => row.targetPR === targetPR && row.status === "open")
    .map(
      (row) =>
        `line ${row.lineNumber}: ${row.path} is open at ${targetPR}; a merge row must be closed there`,
    );

const parseArgs = (argv) => {
  const options = { file: DEFAULT_LEDGER_PATH, patches: null, noOpenAt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file" || arg === "--patches" || arg === "--no-open-at") {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      if (arg === "--no-open-at") options.noOpenAt = next;
      else options[arg.slice(2)] = NodePath.resolve(next);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
};

const main = () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ledger-check: ${error.message}`);
    console.error(
      "Usage: node scripts/personal/sync/ledger-check.mjs [--file <ledger.tsv>] [--patches <dir>] [--no-open-at <PR>]",
    );
    process.exit(2);
  }

  if (!NodeFS.existsSync(options.file)) {
    console.log(`ledger-check: no ledger at ${options.file} (nothing parked yet)`);
    return;
  }

  const { rows, errors } = checkLedgerText(NodeFS.readFileSync(options.file, "utf8"));
  if (options.patches !== null) {
    for (const path of missingPatches(rows, options.patches)) {
      errors.push(`no patch for ${path} under ${options.patches}`);
    }
  }
  if (options.noOpenAt !== null) {
    errors.push(...openAtErrors(rows, options.noOpenAt));
  }

  if (errors.length > 0) {
    console.error(`ledger-check: ${errors.length} error(s) in ${options.file}`);
    for (const error of errors) {
      console.error(`  ${error}`);
    }
    process.exit(1);
  }

  const open = rows.filter((row) => row.status === "open").length;
  console.log(
    `ledger-check: ${rows.length} rows valid (${open} open, ${rows.length - open} closed)`,
  );
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main();
}
