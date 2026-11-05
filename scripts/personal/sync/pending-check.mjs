// Pending check: between the merge and the last fill-in, only the named
// personal tests may fail, and a named test that now passes must leave the list.
//
//   node scripts/personal/sync/pending-check.mjs --results <vitest.json> [--pending <file>]
//
// Run vitest with `--reporter=json --outputFile <vitest.json>`. Paths in the
// pending file are repo-relative (`apps/server/src/personal/...`), one per line,
// `#` starts a comment.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const DEFAULT_PENDING_PATH = NodePath.join(HERE, "v2-port-pending.txt");

const normalizePath = (value) => {
  const normalized = value.replaceAll("\\", "/");
  const marker = "/apps/server/";
  const at = normalized.indexOf(marker);
  return at === -1 ? normalized.replace(/^\.?\//, "") : normalized.slice(at + 1);
};

/** Pending lines: comments and blanks ignored, duplicates rejected. */
export const parsePending = (text) => {
  const files = [];
  const errors = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (NodePath.isAbsolute(line)) {
      errors.push(`line ${index + 1}: use a repo-relative path, got ${line}`);
      continue;
    }
    if (files.includes(line)) {
      errors.push(`line ${index + 1}: duplicate ${line}`);
      continue;
    }
    files.push(line);
  }
  return { files, errors };
};

/**
 * Read a vitest JSON report. A file failed when its result or any assertion
 * failed; skipped files count as neither.
 */
export const readVitestReport = (report) => {
  const testResults = Array.isArray(report?.testResults) ? report.testResults : [];
  const failed = new Set();
  const passed = new Set();
  for (const result of testResults) {
    const file = typeof result?.name === "string" ? normalizePath(result.name) : null;
    if (file === null) {
      continue;
    }
    const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : [];
    const failedAssertion = assertions.some((assertion) => assertion?.status === "failed");
    if (result.status === "failed" || failedAssertion) {
      failed.add(file);
    } else if (result.status === "passed") {
      passed.add(file);
    }
  }
  return { failed, passed };
};

/**
 * The design's two failure rules plus a stale-path note:
 *   - a failing file outside the pending list
 *   - a pending file that passed while still listed
 */
export const checkPending = ({ pending, failed, passed }) => {
  const pendingSet = new Set(pending);
  return {
    outsidePending: [...failed].filter((file) => !pendingSet.has(file)).sort(),
    nowPassing: pending.filter((file) => passed.has(file)),
    notRun: pending.filter((file) => !failed.has(file) && !passed.has(file)),
    allowed: [...failed].filter((file) => pendingSet.has(file)).sort(),
  };
};

const parseArgs = (argv) => {
  const options = { results: null, pending: DEFAULT_PENDING_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--results" || arg === "--pending") {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      options[arg.slice(2)] = NodePath.resolve(next);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.results === null) {
    throw new Error("--results <vitest.json> is required");
  }
  return options;
};

const main = () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`pending-check: ${error.message}`);
    console.error(
      "Usage: node scripts/personal/sync/pending-check.mjs --results <vitest.json> [--pending <file>]",
    );
    process.exit(2);
  }

  let pending;
  try {
    pending = parsePending(
      NodeFS.existsSync(options.pending) ? NodeFS.readFileSync(options.pending, "utf8") : "",
    );
  } catch (error) {
    console.error(`pending-check: ${error.message}`);
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(NodeFS.readFileSync(options.results, "utf8"));
  } catch (error) {
    console.error(`pending-check: cannot read ${options.results}: ${error.message}`);
    process.exit(2);
  }

  const result = checkPending({
    pending: pending.files,
    ...readVitestReport(report),
  });
  const errors = [...pending.errors];
  for (const file of result.outsidePending) {
    errors.push(`failing but not pending: ${file}`);
  }
  for (const file of result.nowPassing) {
    errors.push(`passes and is still pending: ${file}`);
  }

  if (result.notRun.length > 0) {
    console.log(`pending-check: ${result.notRun.length} pending file(s) not in this run`);
  }
  if (errors.length > 0) {
    console.error(`pending-check: ${errors.length} error(s)`);
    for (const error of errors) {
      console.error(`  ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `pending-check: ${result.allowed.length} pending failure(s) allowed, list is current (${pending.files.length} entries)`,
  );
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main();
}
