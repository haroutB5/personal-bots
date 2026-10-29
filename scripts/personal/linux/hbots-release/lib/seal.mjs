// The seal: proof that the artifact that will start is byte-identical to the one the builder's gates ran on,
// and that nothing in it is newer than the evidence start. Written by --prepare, verified by every other mode
// and again right before the restart.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, run, runAsync, sha256File, atomicWrite } from "./util.mjs";

const HASH_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "hash.mjs");

export async function treeInfo(cfg, dir) {
  const r = await runAsync(cfg.node, ["--disable-warning=ExperimentalWarning", HASH_CLI, dir], { low: true, timeoutMs: 10 * 60_000 });
  if (r.code !== 0) throw new Error(`tree hash failed for ${dir}: exit ${r.code} ${r.err.slice(0, 200)}`);
  return JSON.parse(r.out);
}

export function versionFields(text) {
  const out = {};
  for (const key of ["version", "release", "dirty", "externals"]) out[key] = new RegExp(`^${key}=(\\S+)\\s*$`, "m").exec(text)?.[1] ?? null;
  return out;
}

export async function artifactFacts(cfg, a, names) {
  const dir = path.join(cfg.releases, a.release);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Staged release folder ${dir} not found.`);
  const versionPath = path.join(dir, "VERSION");
  const bin = path.join(dir, "dist", "bin.mjs");
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(bin)) throw new Error("Staged release has no dist/bin.mjs.");
  if (!fs.existsSync(nm)) throw new Error("Staged release has no node_modules (externals).");
  if (fs.lstatSync(nm).isSymbolicLink()) throw new Error("Staged node_modules is a symlink into a checkout: build with copied externals so the release is self-contained.");
  const toolsScripts = path.join(names.tools, "scripts");
  const [dist, externals, tools] = await Promise.all([treeInfo(cfg, path.join(dir, "dist")), treeInfo(cfg, nm), treeInfo(cfg, toolsScripts)]);
  return {
    dir,
    fields: versionFields(fs.readFileSync(versionPath, "utf8")),
    versionFileSha: sha256File(versionPath),
    binSha: sha256File(bin),
    dist,
    externals,
    tools,
    node: run(cfg.node, ["--version"]).out,
    evidencePath: path.join(dir, "gate-evidence.json"),
    versionMtimeMs: fs.statSync(versionPath).mtimeMs,
  };
}

/** Returns a list of problems (empty = the artifact matches `expect`). */
export function compareArtifact(facts, expect, a, { legacyNoEvidence = false } = {}) {
  const fail = [];
  if (facts.fields.version !== a.version) fail.push(`VERSION file says version=${facts.fields.version}, expected ${a.version}.`);
  if (facts.fields.release !== a.release) fail.push(`VERSION file says release=${facts.fields.release}, expected ${a.release}.`);
  if (!/^false$/i.test(facts.fields.dirty ?? "")) fail.push(`VERSION file says dirty=${facts.fields.dirty}; a dirty build cannot ship.`);
  if (facts.fields.externals !== "copied") fail.push(`VERSION file says externals=${facts.fields.externals}; only a copied-externals build ships.`);
  if (facts.versionFileSha !== expect.versionFileSha256) fail.push("VERSION file differs from the sealed one.");
  if (facts.binSha !== expect.binSha256) fail.push(`dist/bin.mjs differs from the sealed one (${facts.binSha.slice(0, 12)} vs ${String(expect.binSha256).slice(0, 12)}).`);
  if (facts.dist.sha256 !== expect.dist.sha256) fail.push(`dist differs from the sealed manifest (${facts.dist.files} files now, ${expect.dist.files} sealed).`);
  if (facts.externals.sha256 !== expect.externals.sha256) fail.push(`externals (node_modules) differ from the sealed manifest (${facts.externals.files} files now, ${expect.externals.files} sealed).`);
  if (facts.tools.sha256 !== expect.tools.sha256) fail.push(`tools copy differs from the sealed one (${facts.tools.files} files now, ${expect.tools.files} sealed).`);
  if (facts.node !== expect.node) fail.push(`node is ${facts.node}, the gates ran on ${expect.node}.`);
  if (expect.evidence == null) {
    if (!legacyNoEvidence) fail.push("The seal has no gate evidence: only --guards-only and --dry-run accept it, with --legacy-no-evidence.");
    return fail;
  }
  if (!fs.existsSync(facts.evidencePath)) {
    fail.push("gate-evidence.json is missing.");
  } else {
    if (sha256File(facts.evidencePath) !== expect.evidence.sha256) fail.push("gate-evidence.json differs from the sealed one.");
    const startMs = Number(expect.evidence.startedAtMs);
    const newest = Math.max(facts.dist.newestMtimeMs, facts.externals.newestMtimeMs);
    if (newest > startMs) fail.push(`something in dist or node_modules is newer than the evidence start (${expect.evidence.startedAtIso}): the artifact changed after the gates started.`);
    if (facts.versionMtimeMs > startMs) fail.push("VERSION is newer than the evidence start.");
  }
  return fail;
}

export async function verifySeal(cfg, a, names, opts = {}) {
  const seal = readJson(names.seal);
  if (!seal) throw new Error(`No seal at ${names.seal}. Run hbots-release.mjs --prepare for this release first.`);
  const mismatch = [];
  if (seal.schema !== 1) mismatch.push(`seal schema ${seal.schema}, expected 1.`);
  if (seal.version !== a.version) mismatch.push(`seal is for version ${seal.version}.`);
  if (seal.release !== a.release) mismatch.push(`seal is for release ${seal.release}.`);
  if (seal.mainSha !== a["main-sha"]) mismatch.push(`seal is for notes commit ${seal.mainSha}.`);
  if (seal.rollback !== a.rollback) mismatch.push(`seal was made with rollback ${seal.rollback}.`);
  if (mismatch.length) throw new Error(`Seal does not match this run: ${mismatch.join(" ")}`);
  const facts = await artifactFacts(cfg, a, names);
  const problems = compareArtifact(facts, seal, a, opts);
  if (problems.length) throw new Error(`Staged artifact is not the sealed one: ${problems.slice(0, 6).join(" ")}`);
  return seal;
}

export function readEvidence(evidencePath, binSha, a) {
  const evidence = readJson(evidencePath);
  if (!evidence) throw new Error("gate-evidence.json is missing or unreadable.");
  if (!evidence.startedAt) throw new Error("gate-evidence.json has no top-level startedAt.");
  if (String(evidence.binSha256) !== binSha) throw new Error("gate-evidence binSha256 differs from the staged dist/bin.mjs.");
  if (evidence.release !== a.release) throw new Error(`gate-evidence is for release ${evidence.release}.`);
  const e2e = (evidence.gates ?? []).filter((g) => g.id === "e2e");
  if (e2e.length !== 1) throw new Error("gate-evidence has no single e2e gate.");
  return { evidence, e2e: e2e[0] };
}

export async function writeSeal(cfg, a, names, note) {
  const facts = await artifactFacts(cfg, a, names);
  const { evidence, e2e } = readEvidence(facts.evidencePath, facts.binSha, a);
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
    tools: { dir: names.tools, files: facts.tools.files, sha256: facts.tools.sha256, newestMtimeMs: facts.tools.newestMtimeMs },
    evidence: {
      sha256: sha256File(facts.evidencePath),
      commit: String(evidence.sha),
      startedAtIso: evidence.startedAt,
      startedAtMs: Date.parse(evidence.startedAt),
      finishedAtIso: evidence.finishedAt ?? null,
      e2eJourneys: Number(e2e.counts?.journeys ?? 0),
      e2ePassed: Number(e2e.counts?.passed ?? 0),
    },
  };
  const problems = compareArtifact(facts, seal, a);
  if (problems.length) throw new Error(`Cannot seal: ${problems.join(" ")}`);
  atomicWrite(names.seal, `${JSON.stringify(seal, null, 2)}\n`);
  note(`Seal written: ${names.seal} (dist ${facts.dist.files} files, externals ${facts.externals.files}, tools ${facts.tools.files}, e2e ${seal.evidence.e2ePassed}/${seal.evidence.e2eJourneys} in the evidence).`);
  return seal;
}

/**
 * Legacy seal for a release that predates gate evidence (1.66.95): the same artifact manifest with no evidence
 * block. Only read-only modes may use it (see --legacy-no-evidence); a real run refuses a seal without evidence.
 */
export async function writeLegacySeal(cfg, a, names, note) {
  const facts = await artifactFacts(cfg, a, names);
  const seal = {
    schema: 1, legacy: true, version: a.version, release: a.release, mainSha: a["main-sha"], rollback: a.rollback,
    sealedAt: new Date().toISOString(), node: facts.node, versionFileSha256: facts.versionFileSha, binSha256: facts.binSha,
    dist: facts.dist, externals: facts.externals,
    tools: { dir: names.tools, files: facts.tools.files, sha256: facts.tools.sha256, newestMtimeMs: facts.tools.newestMtimeMs },
    evidence: null,
  };
  const problems = compareArtifact(facts, seal, a, { legacyNoEvidence: true });
  if (problems.length) throw new Error(`Cannot seal: ${problems.join(" ")}`);
  atomicWrite(names.seal, `${JSON.stringify(seal, null, 2)}\n`);
  note(`Legacy seal written (no gate evidence; read-only modes only): ${names.seal}.`);
  return seal;
}
