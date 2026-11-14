// Changed-path selection for the release gate. One gate-inputs table, shared by
// the evidence collector (gate-evidence) and the runner seal. A gate may be
// skipped only when it has a row below and no changed path is one of its inputs.
// A path outside every known area, a missing diff or an unreadable path runs
// every gate.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";

// A top-level file that is not markdown: package.json, the lockfile, tsconfig,
// vite config. Every skippable gate reads them.
export const ROOT_CONFIG = "(root config)";
// Bumped on every release. The staged client and the Android prebuild read it;
// the server tests only check that it exists.
export const APP_VERSION = "scripts/personal/app-version.txt";
// Regenerated in most releases. Only the parity gate reads it, and that gate
// always runs.
export const PARITY_MATRIX = "scripts/personal/parity/parity.json";

// Paths a gate reads although their area is not one of its inputs: server code
// imports these mobile modules, and a server test checks this doc.
export const GATED_PATHS = [
  "apps/hbots-mobile/src/pairing.ts",
  "apps/hbots-mobile/src/dpop.ts",
  "docs/user/t3-connect-troubleshooting.md",
];
// Markdown under these trees can become a code input (a ?raw import, a prompt
// or skill file), so it is never treated as plain docs there.
export const CODE_TREES = ["apps/server/", "apps/web/", "packages/"];

// Every path the table knows. A path that matches none of these runs every gate.
export const KNOWN_AREAS = [
  "apps/server/",
  "apps/web/",
  "apps/hbots-mobile/",
  "packages/",
  "patches/",
  "docs/",
  APP_VERSION,
  PARITY_MATRIX,
  ROOT_CONFIG,
];

// Inputs are directory prefixes (ending in "/"), exact paths or ROOT_CONFIG.
// `except` removes prefixes from the inputs. Gates without a row always run.
export const GATE_INPUTS = {
  "server-tests": {
    inputs: ["apps/server/", "packages/", "patches/", ROOT_CONFIG, ...GATED_PATHS],
    except: ["packages/personal-client/"],
  },
  e2e: {
    inputs: [
      "apps/server/",
      "apps/web/",
      "packages/",
      "patches/",
      ROOT_CONFIG,
      APP_VERSION,
      ...GATED_PATHS,
    ],
  },
  "hbots-mobile-kotlin": {
    inputs: ["apps/hbots-mobile/", "patches/", ROOT_CONFIG, APP_VERSION],
  },
};
export const SKIPPABLE_GATES = Object.keys(GATE_INPUTS);

const isMarkdown = (file) => file.endsWith(".md");
const matches = (file, pattern) => {
  if (pattern === ROOT_CONFIG) return !file.includes("/") && !isMarkdown(file);
  return pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern;
};
const isPlainDoc = (file) => isMarkdown(file) && !CODE_TREES.some((tree) => file.startsWith(tree));
const isKnown = (file) => isPlainDoc(file) || KNOWN_AREAS.some((area) => matches(file, area));
const isInput = (file, row) =>
  row.inputs.some((pattern) => matches(file, pattern)) &&
  !(row.except ?? []).some((pattern) => matches(file, pattern));

const describe = (row) =>
  row.inputs
    .filter((pattern) => !GATED_PATHS.includes(pattern))
    .map((pattern) => (pattern === ROOT_CONFIG ? "top-level config files" : pattern))
    .join(", ") + (row.except ? "; not " + row.except.join(", ") : "");

const runAll = (reason, changedPaths = []) => ({
  skip: [],
  reasons: Object.fromEntries(SKIPPABLE_GATES.map((id) => [id, reason])),
  changedPaths,
  summary: `RUN the full gate (${reason})`,
});

const listed = (files) => files.slice(0, 5).join(", ") + (files.length > 5 ? ", ..." : "");

/**
 * Decide which gates the changed paths let the release skip. Pure.
 * Returns { skip, reasons, changedPaths, summary }: `reasons` has one line per
 * skippable gate, whether it runs or is skipped.
 */
export function classifyGateScope(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return runAll("no changed paths to classify; running the full gate");
  }
  const changedPaths = [];
  for (const value of paths) {
    if (typeof value !== "string")
      return runAll("a changed path is not a string; running the full gate");
    const file = value.trim();
    if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) {
      return runAll(`unsafe changed path ${JSON.stringify(value)}; running the full gate`);
    }
    changedPaths.push(file);
  }
  const unknown = changedPaths.filter((file) => !isKnown(file));
  if (unknown.length) {
    return runAll(`paths outside every known area: ${listed(unknown)}`, changedPaths);
  }
  const skip = [];
  const reasons = {};
  for (const [id, row] of Object.entries(GATE_INPUTS)) {
    const hits = changedPaths.filter((file) => isInput(file, row));
    if (hits.length) {
      reasons[id] = `${id} inputs changed: ${listed(hits)}`;
    } else {
      skip.push(id);
      reasons[id] = `no changed path is an input of ${id}: ${describe(row)}`;
    }
  }
  const ran = SKIPPABLE_GATES.filter((id) => !skip.includes(id));
  return {
    skip,
    reasons,
    changedPaths,
    summary: skip.length
      ? `SKIP ${skip.join(", ")}${ran.length ? `; RUN ${ran.join(", ")}` : ""}`
      : "RUN the full gate (every skippable gate has a changed input)",
  };
}

/**
 * The runner-seal check. It takes the diff the caller recomputed from the live
 * release to the release under test, never the evidence's own claim, and checks
 * each skipped gate against the table.
 */
export function verifySkippedGates({ evidence, liveSha, releaseSha, changedPaths }) {
  const skipped = (evidence?.gates ?? []).filter((gate) => gate?.skipped === true);
  if (skipped.length === 0) return [];
  const problems = [];
  if (!/^[a-f0-9]{40}$/.test(liveSha ?? "")) {
    problems.push(
      `cannot verify skipped gates: the live release ${liveSha ?? "(missing)"} is not a commit`,
    );
  }
  if (!/^[a-f0-9]{40}$/.test(releaseSha ?? "")) {
    problems.push(
      `cannot verify skipped gates: the release ${releaseSha ?? "(missing)"} is not a commit`,
    );
  }
  if (problems.length) return problems;

  const scope = classifyGateScope(changedPaths);
  const expected = [...scope.changedPaths].sort();
  for (const gate of skipped) {
    if (!SKIPPABLE_GATES.includes(gate.id)) {
      problems.push(`gate ${gate.id} may not be skipped`);
    } else if (!scope.skip.includes(gate.id)) {
      problems.push(
        `evidence skips ${gate.id} but the live-to-release diff must run it: ${scope.reasons[gate.id]}`,
      );
    }
    if (gate.baseSha !== liveSha)
      problems.push(
        `gate ${gate.id} claims base ${gate.baseSha ?? "(missing)"}, live is ${liveSha}`,
      );
    if (typeof gate.reason !== "string" || !gate.reason.trim())
      problems.push(`gate ${gate.id} has no skip reason`);
    const claimed = Array.isArray(gate.changedPaths) ? gate.changedPaths.map(String).sort() : [];
    if (
      claimed.length !== expected.length ||
      claimed.some((file, index) => file !== expected[index])
    ) {
      problems.push(`gate ${gate.id} changedPaths differ from the live-to-release diff`);
    }
  }
  return problems;
}

const invokedDirectly = () => {
  try {
    return NodePath.resolve(NodeProcess.argv[1] ?? "") === NodeURL.fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  const [base, head, repo = "."] = NodeProcess.argv.slice(2);
  if (!base || !head) {
    console.error("Usage: node gateScope.mjs <base-sha> <head-sha> [repo]");
    NodeProcess.exit(2);
  }
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const baseSha = git("rev-parse", "--verify", `${base}^{commit}`);
  const headSha = git("rev-parse", "--verify", `${head}^{commit}`);
  const changedPaths = git("diff", "--no-renames", "--name-only", baseSha, headSha)
    .split("\n")
    .filter(Boolean);
  console.log(JSON.stringify({ baseSha, headSha, ...classifyGateScope(changedPaths) }, null, 2));
}
