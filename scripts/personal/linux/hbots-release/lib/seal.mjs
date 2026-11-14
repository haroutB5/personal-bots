// The seal: proof that the artifact that will start is byte-identical to the one the builder's gates ran on,
// and that nothing in it is newer than the evidence start. Written by --prepare, verified by every other mode
// and again right before the restart.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { readJson, run, runAsync, sha256File, atomicWrite } from "./util.mjs";
import { verifySkippedGates } from "./gateScope.mjs";

const HASH_CLI = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "hash.mjs",
);

export async function treeInfo(cfg, dir) {
  const r = await runAsync(cfg.node, ["--disable-warning=ExperimentalWarning", HASH_CLI, dir], {
    low: true,
    timeoutMs: 10 * 60_000,
  });
  if (r.code !== 0)
    throw new Error(`tree hash failed for ${dir}: exit ${r.code} ${r.err.slice(0, 200)}`);
  return JSON.parse(r.out);
}

export function versionFields(text) {
  const out = {};
  for (const key of ["version", "release", "dirty", "externals"])
    out[key] = new RegExp(`^${key}=(\\S+)\\s*$`, "m").exec(text)?.[1] ?? null;
  return out;
}

export async function artifactFacts(cfg, a, names) {
  const dir = NodePath.join(cfg.releases, a.release);
  if (!NodeFS.existsSync(dir) || !NodeFS.statSync(dir).isDirectory())
    throw new Error(`Staged release folder ${dir} not found.`);
  const versionPath = NodePath.join(dir, "VERSION");
  const bin = NodePath.join(dir, "dist", "bin.mjs");
  const nm = NodePath.join(dir, "node_modules");
  if (!NodeFS.existsSync(bin)) throw new Error("Staged release has no dist/bin.mjs.");
  if (!NodeFS.existsSync(nm)) throw new Error("Staged release has no node_modules (externals).");
  if (NodeFS.lstatSync(nm).isSymbolicLink())
    throw new Error(
      "Staged node_modules is a symlink into a checkout: build with copied externals so the release is self-contained.",
    );
  const toolsScripts = NodePath.join(names.tools, "scripts");
  const [dist, externals, tools] = await Promise.all([
    treeInfo(cfg, NodePath.join(dir, "dist")),
    treeInfo(cfg, nm),
    treeInfo(cfg, toolsScripts),
  ]);
  return {
    dir,
    fields: versionFields(NodeFS.readFileSync(versionPath, "utf8")),
    versionFileSha: sha256File(versionPath),
    binSha: sha256File(bin),
    dist,
    externals,
    tools,
    node: run(cfg.node, ["--version"]).out,
    evidencePath: NodePath.join(dir, "gate-evidence.json"),
    versionMtimeMs: NodeFS.statSync(versionPath).mtimeMs,
  };
}

/** Returns a list of problems (empty = the artifact matches `expect`). */
export function compareArtifact(facts, expect, a, { legacyNoEvidence = false } = {}) {
  const fail = [];
  if (facts.fields.version !== a.version)
    fail.push(`VERSION file says version=${facts.fields.version}, expected ${a.version}.`);
  if (facts.fields.release !== a.release)
    fail.push(`VERSION file says release=${facts.fields.release}, expected ${a.release}.`);
  if (!/^false$/i.test(facts.fields.dirty ?? ""))
    fail.push(`VERSION file says dirty=${facts.fields.dirty}; a dirty build cannot ship.`);
  if (facts.fields.externals !== "copied")
    fail.push(
      `VERSION file says externals=${facts.fields.externals}; only a copied-externals build ships.`,
    );
  if (facts.versionFileSha !== expect.versionFileSha256)
    fail.push("VERSION file differs from the sealed one.");
  if (facts.binSha !== expect.binSha256)
    fail.push(
      `dist/bin.mjs differs from the sealed one (${facts.binSha.slice(0, 12)} vs ${String(expect.binSha256).slice(0, 12)}).`,
    );
  if (facts.dist.sha256 !== expect.dist.sha256)
    fail.push(
      `dist differs from the sealed manifest (${facts.dist.files} files now, ${expect.dist.files} sealed).`,
    );
  if (facts.externals.sha256 !== expect.externals.sha256)
    fail.push(
      `externals (node_modules) differ from the sealed manifest (${facts.externals.files} files now, ${expect.externals.files} sealed).`,
    );
  if (facts.tools.sha256 !== expect.tools.sha256)
    fail.push(
      `tools copy differs from the sealed one (${facts.tools.files} files now, ${expect.tools.files} sealed).`,
    );
  if (facts.node !== expect.node)
    fail.push(`node is ${facts.node}, the gates ran on ${expect.node}.`);
  if (expect.evidence == null) {
    if (!legacyNoEvidence)
      fail.push(
        "The seal has no gate evidence: only --guards-only and --dry-run accept it, with --legacy-no-evidence.",
      );
    return fail;
  }
  if (!NodeFS.existsSync(facts.evidencePath)) {
    fail.push("gate-evidence.json is missing.");
  } else {
    if (sha256File(facts.evidencePath) !== expect.evidence.sha256)
      fail.push("gate-evidence.json differs from the sealed one.");
    const startMs = Number(expect.evidence.startedAtMs);
    const newest = Math.max(facts.dist.newestMtimeMs, facts.externals.newestMtimeMs);
    if (newest > startMs)
      fail.push(
        `something in dist or node_modules is newer than the evidence start (${expect.evidence.startedAtIso}): the artifact changed after the gates started.`,
      );
    if (facts.versionMtimeMs > startMs) fail.push("VERSION is newer than the evidence start.");
  }
  return fail;
}

export async function verifySeal(cfg, a, names, opts = {}) {
  const seal = readJson(names.seal);
  if (!seal)
    throw new Error(
      `No seal at ${names.seal}. Run hbots-release.mjs --prepare for this release first.`,
    );
  const mismatch = [];
  if (seal.schema !== 1) mismatch.push(`seal schema ${seal.schema}, expected 1.`);
  if (seal.version !== a.version) mismatch.push(`seal is for version ${seal.version}.`);
  if (seal.release !== a.release) mismatch.push(`seal is for release ${seal.release}.`);
  if (seal.mainSha !== a["main-sha"]) mismatch.push(`seal is for notes commit ${seal.mainSha}.`);
  if (seal.rollback !== a.rollback) mismatch.push(`seal was made with rollback ${seal.rollback}.`);
  if (mismatch.length) throw new Error(`Seal does not match this run: ${mismatch.join(" ")}`);
  const facts = await artifactFacts(cfg, a, names);
  const problems = compareArtifact(facts, seal, a, opts);
  if (problems.length)
    throw new Error(`Staged artifact is not the sealed one: ${problems.slice(0, 6).join(" ")}`);
  if (seal.evidence != null) {
    const skips = skipEvidenceProblems(cfg, a, readJson(facts.evidencePath));
    if (skips.length)
      throw new Error(`Skipped gates are not justified: ${skips.slice(0, 4).join(" ")}`);
  }
  return seal;
}

/**
 * Recompute the live-to-release diff and refuse a skip the allowlist does not
 * cover. The evidence's baseSha and changedPaths are compared with that diff,
 * never trusted as the source of truth.
 */
export function skipEvidenceProblems(cfg, a, evidence) {
  const skipped = (evidence?.gates ?? []).filter((gate) => gate?.skipped === true);
  if (skipped.length === 0) return [];
  let live = "";
  try {
    live = NodeFS.readFileSync(cfg.currentTxt, "utf8").trim();
  } catch {}
  const resolve = (rev) => {
    if (!rev) return null;
    const r = run("git", ["-C", a["repo-root"], "rev-parse", "--verify", `${rev}^{commit}`], {
      timeout: 60_000,
    });
    return r.code === 0 ? r.out.split("\n")[0].trim() : null;
  };
  const liveSha = resolve(live);
  const releaseSha = resolve(a.release);
  if (!liveSha || !releaseSha) {
    return [
      `cannot verify skipped gates: live ${live || "(missing)"} and release ${a.release} are not both commits in ${a["repo-root"]}`,
    ];
  }
  const diff = run(
    "git",
    ["-C", a["repo-root"], "diff", "--no-renames", "--name-only", liveSha, releaseSha],
    { timeout: 120_000 },
  );
  if (diff.code !== 0) {
    return [
      `cannot verify skipped gates: git diff ${liveSha.slice(0, 12)}..${releaseSha.slice(0, 12)} failed: ${diff.err.slice(0, 200)}`,
    ];
  }
  return verifySkippedGates({
    evidence,
    liveSha,
    releaseSha,
    changedPaths: diff.out.split("\n").filter(Boolean),
  });
}

export function readEvidence(evidencePath, binSha, a) {
  const evidence = readJson(evidencePath);
  if (!evidence) throw new Error("gate-evidence.json is missing or unreadable.");
  if (!evidence.startedAt) throw new Error("gate-evidence.json has no top-level startedAt.");
  if (String(evidence.binSha256) !== binSha)
    throw new Error("gate-evidence binSha256 differs from the staged dist/bin.mjs.");
  if (evidence.release !== a.release)
    throw new Error(`gate-evidence is for release ${evidence.release}.`);
  const e2e = (evidence.gates ?? []).filter((g) => g.id === "e2e");
  if (e2e.length !== 1) throw new Error("gate-evidence has no single e2e gate.");
  return { evidence, e2e: e2e[0] };
}

export async function writeSeal(cfg, a, names, note) {
  const facts = await artifactFacts(cfg, a, names);
  const { evidence, e2e } = readEvidence(facts.evidencePath, facts.binSha, a);
  const skips = skipEvidenceProblems(cfg, a, evidence);
  if (skips.length) throw new Error(`Cannot seal: ${skips.join(" ")}`);
  const e2eSkipped = e2e.skipped === true;
  const seal = {
    schema: 1,
    version: a.version,
    release: a.release,
    mainSha: a["main-sha"],
    rollback: a.rollback,
    sealedAt: new Date().toISOString(),
    node: facts.node,
    versionFileSha256: facts.versionFileSha,
    binSha256: facts.binSha,
    dist: facts.dist,
    externals: facts.externals,
    tools: {
      dir: names.tools,
      files: facts.tools.files,
      sha256: facts.tools.sha256,
      newestMtimeMs: facts.tools.newestMtimeMs,
    },
    evidence: {
      sha256: sha256File(facts.evidencePath),
      commit: String(evidence.sha),
      startedAtIso: evidence.startedAt,
      startedAtMs: Date.parse(evidence.startedAt),
      finishedAtIso: evidence.finishedAt ?? null,
      e2eJourneys: e2eSkipped ? 0 : Number(e2e.counts?.journeys ?? 0),
      e2ePassed: e2eSkipped ? 0 : Number(e2e.counts?.passed ?? 0),
      e2eSkipped,
    },
  };
  const problems = compareArtifact(facts, seal, a);
  if (problems.length) throw new Error(`Cannot seal: ${problems.join(" ")}`);
  atomicWrite(names.seal, `${JSON.stringify(seal, null, 2)}\n`);
  note(
    `Seal written: ${names.seal} (dist ${facts.dist.files} files, externals ${facts.externals.files}, tools ${facts.tools.files}, e2e ${e2eSkipped ? "skipped by the gate-inputs table" : `${seal.evidence.e2ePassed}/${seal.evidence.e2eJourneys}`} in the evidence).`,
  );
  for (const gate of (evidence.gates ?? []).filter((g) => g?.skipped === true))
    note(`Gate ${gate.id} skipped: ${gate.reason}`);
  return seal;
}

/**
 * Legacy seal for a release that predates gate evidence (1.66.95): the same artifact manifest with no evidence
 * block. Only read-only modes may use it (see --legacy-no-evidence); a real run refuses a seal without evidence.
 */
export async function writeLegacySeal(cfg, a, names, note) {
  const facts = await artifactFacts(cfg, a, names);
  const seal = {
    schema: 1,
    legacy: true,
    version: a.version,
    release: a.release,
    mainSha: a["main-sha"],
    rollback: a.rollback,
    sealedAt: new Date().toISOString(),
    node: facts.node,
    versionFileSha256: facts.versionFileSha,
    binSha256: facts.binSha,
    dist: facts.dist,
    externals: facts.externals,
    tools: {
      dir: names.tools,
      files: facts.tools.files,
      sha256: facts.tools.sha256,
      newestMtimeMs: facts.tools.newestMtimeMs,
    },
    evidence: null,
  };
  const problems = compareArtifact(facts, seal, a, { legacyNoEvidence: true });
  if (problems.length) throw new Error(`Cannot seal: ${problems.join(" ")}`);
  atomicWrite(names.seal, `${JSON.stringify(seal, null, 2)}\n`);
  note(`Legacy seal written (no gate evidence; read-only modes only): ${names.seal}.`);
  return seal;
}
