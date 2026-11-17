// Test-line budget for one change. Pure: the callers read git and pass plain data in.
// A change adds at most `limit` net test lines on fork paths. A change whose test
// lines sit in one file is never blocked. Over that, the lead records an allowance
// row in the repo and the row names the number it excuses.
// The guard only reports until the allowance file at the change's base says
// `"enforce": true`. It is read from the base, like the limit, so a change cannot
// switch the guard on or off for itself. Absent means report mode.

export const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
export const KOTLIN_TEST = /^apps\/hbots-mobile\/modules\/[^/]+\/android\/src\/test\/.+\.kt$/;

export const FORK_TEST_ROOTS = [
  "apps/hbots-mobile/",
  "apps/server/src/personal/",
  "packages/personal-client/",
  "scripts/personal/",
];
export const ALLOWANCE_FILE = "scripts/personal/qa/test-budget-allowances.json";
export const DEFAULT_LIMIT = 400;
export const REPORT_MODE_LINE = `test budget: report mode, this does not block the release (set "enforce": true in ${ALLOWANCE_FILE} to block)`;

const isTestName = (path) => TEST_NAME.test(path) || KOTLIN_TEST.test(path);

/** A test file of a fork-owned tree. Fixtures, golden files and helpers are not. */
export const isForkTest = (path) =>
  FORK_TEST_ROOTS.some((root) => path.startsWith(root)) && isTestName(path);

const text = (value) => typeof value === "string" && value.trim() !== "";
const rowKey = (row) => JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)));

function readAllowanceFile(source) {
  if (source == null) return { rows: [] };
  let data;
  try {
    data = JSON.parse(source);
  } catch (error) {
    return { rows: [], problem: `is not valid JSON: ${error.message}` };
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.allowances))
    return { rows: [], problem: "needs an allowances array" };
  if (data.limit !== undefined && !(Number.isInteger(data.limit) && data.limit > 0))
    return { rows: [], problem: "limit must be a positive whole number" };
  if (data.enforce !== undefined && typeof data.enforce !== "boolean")
    return { rows: [], problem: "enforce must be true or false" };
  return { limit: data.limit, enforce: data.enforce === true, rows: data.allowances };
}

function rowProblem(row, exists) {
  if (!row || typeof row !== "object") return "a row is not an object";
  const label = text(row.change) ? row.change : "(no change name)";
  if (!text(row.change)) return `${label}: change is required`;
  if (!Number.isInteger(row.lines) || row.lines <= 0)
    return `${label}: lines must be a positive whole number`;
  if (!text(row.reason)) return `${label}: reason is required`;
  if (!text(row.strongest)) return `${label}: strongest is required`;
  if (!isTestName(row.strongest) || !exists(row.strongest))
    return `${label}: strongest ${row.strongest} is not a test file in this change`;
  return null;
}

/**
 * The allowance rows this change adds: present in the file at head and absent at
 * base, so an old row can never excuse a later change. `baseFile` and `headFile`
 * are file contents, or null when the file does not exist. The limit is the
 * base's, so a change cannot raise its own. Any unreadable file or invalid new
 * row is a problem, never a silent pass.
 */
export function newAllowances(baseFile, headFile, { exists = () => true } = {}) {
  const base = readAllowanceFile(baseFile);
  const head = readAllowanceFile(headFile);
  const problems = [
    ...(base.problem ? [`allowance file at base ${base.problem}`] : []),
    ...(head.problem ? [`allowance file at head ${head.problem}`] : []),
  ];
  const old = new Set(base.rows.map((row) => (row && typeof row === "object" ? rowKey(row) : "")));
  const added = head.rows.filter(
    (row) => !(row && typeof row === "object" && old.has(rowKey(row))),
  );
  for (const row of added) {
    const problem = rowProblem(row, exists);
    if (problem) problems.push(`allowance row ${problem}`);
  }
  return {
    limit: base.limit ?? DEFAULT_LIMIT,
    enforce: base.enforce === true,
    rows: added.filter((row) => !rowProblem(row, exists)).sort((a, b) => b.lines - a.lines),
    problems,
  };
}

/**
 * One change against its limit. `deltas` is `{ path, net }` per changed file; only
 * fork test files count. `net` is lines at head minus lines at base.
 * `code` is `{ added, deleted }` of the fork code in the same change, for the report.
 */
export function judgeChange({ id, deltas, limit = DEFAULT_LIMIT, allowance, code }) {
  const tests = deltas.filter((delta) => isForkTest(delta.path));
  const net = tests.reduce((sum, delta) => sum + delta.net, 0);
  let verdict = "over";
  if (net <= limit) verdict = "ok";
  else if (tests.length === 1) verdict = "single-file";
  else if (allowance && net <= allowance.lines) verdict = "allowed";
  return {
    id,
    net,
    files: tests.length,
    limit,
    verdict,
    tests: tests.toSorted((a, b) => b.net - a.net || (a.path < b.path ? -1 : 1)),
    ...(verdict === "allowed" ? { allowance } : {}),
    ...(code ? { code } : {}),
  };
}

const signed = (n) => (n < 0 ? `${n}` : `+${n}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The lines to print for one judged change. Only `over` starts with FAIL. */
export function budgetLines(result) {
  const head = `${result.id} ${signed(result.net)} net test lines in ${plural(result.files, "file")}`;
  if (result.verdict === "ok") return [`test budget: ${head} (limit ${result.limit}): ok`];
  if (result.verdict === "single-file")
    return [
      `test budget: ${head} (limit ${result.limit}): single-file, never blocked, ${signed(result.net)} in ${result.tests[0].path}`,
    ];
  if (result.verdict === "allowed") {
    const { allowance } = result;
    return [
      `test budget: ${head} (limit ${result.limit}): allowed ${result.net} of ${allowance.lines} by ${allowance.by ?? "(no name)"}: ${allowance.reason}`,
    ];
  }
  const over = result.net - result.limit;
  return [
    `FAIL test budget: ${head}, limit ${result.limit}, over by ${over}`,
    ...result.tests.map((delta) => `  ${signed(delta.net)} ${delta.path}`),
    ...(result.code
      ? [`  code in this change: +${result.code.added} -${result.code.deleted}`]
      : []),
    `  to pass: delete or merge ${over} test lines the new tests make redundant, or ask the lead`,
    `  for a row in ${ALLOWANCE_FILE}`,
  ];
}
