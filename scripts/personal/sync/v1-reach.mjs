// v1 reach: personal files that still read one of the five v1 projection tables.
//
//   node scripts/personal/sync/v1-reach.mjs <repo> [--list] [--json] [--baseline <path>]
//
// The import detector retired at M1b: tsc already fails on a missing module.
// The tables check stays because a query can read a dropped table with no type
// error. The baseline is empty on the merged tree.
//
// Exit codes: 0 census matches the baseline, 1 unexpected or stale entry,
// 2 usage or git error.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const V1_TABLES = [
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_sessions",
  "projection_turns",
  "projection_thread_activities",
];

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const DEFAULT_BASELINE_PATH = NodePath.join(HERE, "v1-reach.baseline.json");

/** Personal layer plus the contract files the personal wire uses. */
export const isPersonalPath = (path) =>
  /\.tsx?$/.test(path) &&
  !path.includes(".test.") &&
  !path.includes("/test/") &&
  (path.includes("/personal/") || /^packages\/contracts\/src\/personal[A-Za-z]*\.ts$/.test(path));

export const tableReadsFor = ({ file, source }) => {
  const rows = [];
  for (const table of V1_TABLES) {
    if (new RegExp(`\\b${table}\\b`).test(source)) {
      rows.push({ path: file, kind: "tables", detail: table });
    }
  }
  return rows;
};

export const censusFiles = (rows) => {
  const byFile = new Map();
  for (const row of rows) {
    const evidence = byFile.get(row.path) ?? [];
    evidence.push({ kind: row.kind, detail: row.detail });
    byFile.set(row.path, evidence);
  }
  return new Map([...byFile.entries()].sort(([left], [right]) => left.localeCompare(right)));
};

/**
 * Compare the detector with the committed baseline. `expected` maps a direct
 * path to null. `exists` checks a baseline path is still in the repo.
 */
export const classifyReach = ({ census, expected, exists }) => {
  const direct = [...census.keys()];
  const unexpected = direct.filter((path) => !expected.has(path));
  const indirect = [...expected.keys()].filter((path) => !census.has(path));
  const stale = [...expected.keys()].filter((path) => !exists(path));
  return {
    direct,
    indirect: indirect.map((path) => ({ path, reason: expected.get(path) ?? "not detected" })),
    unexpected,
    stale,
    total: new Set([...census.keys(), ...expected.keys()]).size,
  };
};

export const parseBaseline = (value) => {
  if (typeof value !== "object" || value === null || !Array.isArray(value.files)) {
    throw new Error("v1-reach baseline: expected an object with a files array");
  }
  const reasons = value.indirectReasons ?? {};
  if (typeof reasons !== "object" || reasons === null || Array.isArray(reasons)) {
    throw new Error("v1-reach baseline: indirectReasons must be an object");
  }
  const expected = new Map();
  for (const file of value.files) {
    if (typeof file !== "string" || file.length === 0) {
      throw new Error("v1-reach baseline: files must be non-empty strings");
    }
    if (expected.has(file)) {
      throw new Error(`v1-reach baseline: duplicate file ${file}`);
    }
    expected.set(file, typeof reasons[file] === "string" ? reasons[file] : null);
  }
  for (const file of Object.keys(reasons)) {
    if (!expected.has(file)) {
      throw new Error(`v1-reach baseline: indirect reason for a file not in files: ${file}`);
    }
  }
  return expected;
};

const git = (repo, ...args) =>
  NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

const parseArgs = (argv) => {
  const repo = argv[0];
  if (repo === undefined || repo.startsWith("--")) {
    throw new Error("first argument must be the repo path");
  }
  const options = { repo, list: false, json: false, baseline: DEFAULT_BASELINE_PATH };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list") {
      options.list = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--baseline") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error("--baseline needs a value");
      options.baseline = next;
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
    console.error(`v1-reach: ${error.message}`);
    console.error(
      "Usage: node scripts/personal/sync/v1-reach.mjs <repo> [--list] [--json] [--baseline <path>]",
    );
    process.exit(2);
  }

  let files;
  try {
    files = new Set(
      git(options.repo, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean),
    );
  } catch (error) {
    console.error(`v1-reach: cannot read HEAD: ${error.message}`);
    process.exit(2);
  }

  const rows = [];
  for (const file of [...files].filter(isPersonalPath)) {
    rows.push(...tableReadsFor({ file, source: git(options.repo, "show", `HEAD:${file}`) }));
  }

  const census = censusFiles(rows);
  let expected;
  try {
    expected = parseBaseline(JSON.parse(NodeFS.readFileSync(options.baseline, "utf8")));
  } catch (error) {
    console.error(`v1-reach: ${error.message}`);
    process.exit(2);
  }

  const result = classifyReach({ census, expected, exists: (path) => files.has(path) });

  if (options.list) {
    for (const path of [...expected.keys()].sort()) console.log(path);
    process.exit(result.unexpected.length === 0 && result.stale.length === 0 ? 0 : 1);
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          total: result.total,
          direct: [...census.entries()].map(([path, evidence]) => ({ path, evidence })),
          indirect: result.indirect,
          unexpected: result.unexpected,
          stale: result.stale,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `v1 reach: ${result.total} personal files (${result.direct.length} direct, ${result.indirect.length} indirect)`,
    );
    for (const [path, evidence] of census) {
      for (const item of evidence) console.log(`  ${path}\t${item.kind}\t${item.detail}`);
    }
    for (const entry of result.indirect) console.log(`  ${entry.path}\tindirect\t${entry.reason}`);
  }

  if (result.unexpected.length > 0) {
    console.error(
      `v1-reach: ${result.unexpected.length} file(s) reach v1 but are not in the baseline:`,
    );
    for (const path of result.unexpected) console.error(`  ${path}`);
  }
  if (result.stale.length > 0) {
    console.error(`v1-reach: ${result.stale.length} baseline file(s) no longer exist:`);
    for (const path of result.stale) console.error(`  ${path}`);
  }
  process.exit(result.unexpected.length === 0 && result.stale.length === 0 ? 0 : 1);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main();
}
