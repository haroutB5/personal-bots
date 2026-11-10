// Changed-path selection for the release gate. One allowlist, shared by the
// evidence collector (gate-evidence) and the runner seal. Every path not on the
// allowlist runs the full gate; a missing or unreadable diff runs it too.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";

// Only these two gates may be skipped, and only for the paths below.
export const SKIPPABLE_GATES = ["server-tests", "e2e"];
export const SAFE_PREFIXES = ["apps/hbots-mobile/", "docs/"];

const run = (reason) => ({ action: "run", reason, changedPaths: [] });

const isSafe = (file) =>
  SAFE_PREFIXES.some((prefix) => file.startsWith(prefix)) || file.endsWith(".md");

/** Classify changed paths into a full run or a mobile/docs-only skip. Pure. */
export function classifyGateScope(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return run("no changed paths to classify; running the full gate");
  }
  const changedPaths = [];
  for (const value of paths) {
    if (typeof value !== "string")
      return run("a changed path is not a string; running the full gate");
    const file = value.trim();
    if (!file || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) {
      return run(`unsafe changed path ${JSON.stringify(value)}; running the full gate`);
    }
    changedPaths.push(file);
  }
  const blocked = changedPaths.filter((file) => !isSafe(file));
  if (blocked.length) {
    return {
      action: "run",
      reason: `paths outside the mobile/docs allowlist: ${blocked.slice(0, 5).join(", ")}`,
      changedPaths,
    };
  }
  return {
    action: "skip",
    reason: "every changed path is under apps/hbots-mobile/, under docs/, or a markdown file",
    changedPaths,
  };
}

/**
 * The runner-seal check. It takes the diff the caller recomputed from the live
 * release to the release under test, never the evidence's own claim.
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
  if (scope.action !== "skip") {
    problems.push(
      `evidence skips ${skipped.map((gate) => gate.id).join(", ")} but the live-to-release diff must run: ${scope.reason}`,
    );
  }
  const expected = [...scope.changedPaths].sort();
  for (const gate of skipped) {
    if (!SKIPPABLE_GATES.includes(gate.id)) problems.push(`gate ${gate.id} may not be skipped`);
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
