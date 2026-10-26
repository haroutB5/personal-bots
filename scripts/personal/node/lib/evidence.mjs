// Release guards for the Linux flow, shared by `hbots.mjs` and the release
// waiter: a staged release may not be activated without clean release notes
// and passing gate evidence for the exact commit and artifact being activated.
//
// The check is deliberately the same one DevOps runs by hand
// (scripts/personal/linux/dev-team-tools/check-gate-evidence.mjs), so there is
// one definition of "has evidence". Rollbacks are exempt: the older release
// predates the Linux evidence format, and refusing a rollback would keep a bad
// release live.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CHECKER = path.join(
  "scripts",
  "personal",
  "linux",
  "dev-team-tools",
  "check-gate-evidence.mjs",
);

/** `1.66.96` -> [1, 66, 96]; null when it is not a version. */
export function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return match ? match.slice(1).map(Number) : null;
}

/** True when `candidate` is older than `current` (a rollback, which needs no fresh evidence). */
export function isOlderRelease(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index];
  }
  return false;
}

/** The HANDOFF name for a version: 1.66.8 -> HANDOFF-1668.md. */
export const notesFileName = (version) => `HANDOFF-${version.replaceAll(".", "")}.md`;

const PLACEHOLDERS = [
  [/\bPROOF_PLACEHOLDER\b/, "PROOF_PLACEHOLDER"],
  [/\bTODO\b/, "TODO"],
  [/\bTBD\b/, "TBD"],
  [/\bFIXME\b/, "FIXME"],
  [/\bXXX\b/, "XXX"],
  [/\bto be (filled|written|added|determined)\b/i, "to be filled/written/added/determined"],
  [/<(fill in|insert)[^>]*>/i, "<fill in ...>/<insert ...> only"],
  [/\blorem ipsum\b/i, "lorem ipsum"],
];

/**
 * Release notes from the release commit (not the working tree, which may have
 * moved on). Returns the problems, empty when clean.
 */
export function releaseNotesProblems({ repoRoot, version, commit }) {
  const problems = [];
  const relative = path.join("docs", "releases", notesFileName(version));
  let text = "";
  if (commit) {
    const shown = spawnSync("git", ["-C", repoRoot, "show", `${commit}:${relative}`], {
      encoding: "utf8",
    });
    if (shown.status !== 0) problems.push(`${relative} is not in commit ${commit}.`);
    else text = shown.stdout;
  } else {
    try {
      text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    } catch {
      problems.push(`${relative} does not exist.`);
    }
  }
  if (text.trim().length > 0) {
    for (const [pattern, label] of PLACEHOLDERS) {
      if (pattern.test(text)) problems.push(`${relative} still holds ${label}.`);
    }
    if (text.trim().length < 200) {
      problems.push(`${relative} is a stub (${text.trim().length} characters).`);
    }
  }
  return problems;
}

/**
 * Runs the gate-evidence checker for a staged release. `commit` is the notes
 * commit that must contain the evidence marker and be ahead of the gated code.
 * Returns `{ ok, output }`.
 */
export function checkGateEvidence({ repoRoot, version, release, commit }) {
  const checker = path.join(repoRoot, CHECKER);
  if (!fs.existsSync(checker)) {
    return { ok: false, output: `Gate evidence checker missing: ${checker}` };
  }
  const args = [
    checker,
    "--version",
    version,
    "--release",
    release,
    "--repo-root",
    repoRoot,
    ...(commit ? ["--commit", commit] : []),
  ];
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    cwd: repoRoot,
    // Inheriting fd 9 lets the checker reuse the heavy-job lock instead of
    // queueing for it while the caller already holds it.
    stdio: [
      "ignore",
      "pipe",
      "pipe",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "inherit",
    ],
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/**
 * The whole guard: notes and evidence for one staged release. Throws with the
 * checker's own words, so a refusal names the missing gate.
 */
export function assertReleaseReady({ repoRoot, version, release, commit }) {
  const notes = releaseNotesProblems({ repoRoot, version, commit });
  if (notes.length > 0) {
    throw new Error(`Release notes are not ready:\n- ${notes.join("\n- ")}`);
  }
  const evidence = checkGateEvidence({ repoRoot, version, release, commit });
  if (!evidence.ok) {
    throw new Error(
      `Gate evidence does not pass for ${release} (${version}); the release was NOT activated.\n${evidence.output}`,
    );
  }
  return evidence.output;
}
