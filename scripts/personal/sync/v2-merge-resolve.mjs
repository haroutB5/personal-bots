// v2 merge resolver. Applies the B1 rules to a real merge and parks every
// personal hunk in the ledger instead of losing it.
//
//   node scripts/personal/sync/v2-merge-resolve.mjs --repo <clone> --ours <branch-or-sha> \
//     --theirs <upstream-ref> [--base <sha>] [--ledger <dir>] [--assignments <file>] [--apply]
//
// Base defaults to `git merge-base ours theirs`, never a hard-coded merge point.
// Run it in a throwaway clone, never on a real branch. Without --apply the nine
// seam files stay unmerged for a human; with --apply they take upstream's side
// and the report lists the registration lines to re-add.
//
// Rules, in order (design Appendix E.2 and Appendix G), first match wins:
//   1. backport     every non-merge commit on our side is an upstream cherry-pick
//   2. superseded   our only change at the path is a commit upstream already has
//   3. registry     v2-port-targets.tsv names the target and the status after B1
//   4. v1-stub      a test whose added lines only stub v1 services
//   5. follow-source a test takes the target of the source it tests
//   6. area         provider, DeepSeek, orchestration, web and contracts areas
//   7. no match     fail with the path; never park it at B1 open
//
// Merge mechanics, in order (design section 4, B1):
//   1. merge.directoryRenames=false
//   2. modify-delete: take the deletion, park our diff
//   3. our added files that no longer compile: remove, park the whole file
//   4. content conflicts outside the seam: take upstream, park our hunk
//   5. seam allowlist: take upstream, then re-add our one registration line
//   6. migrations: resolve-migrations.ts (the caller runs it)
//
// Exit codes: 0 dry run resolved as far as it can, 1 unresolvable conflict, a
// renamed-into-v2 path or a row with no target, 2 usage or git error.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveImportTarget } from "./v1-reach.mjs";

export const SEAM_FILES = [
  "apps/server/src/persistence/Migrations.ts",
  "apps/server/src/server.ts",
  "apps/server/src/ws.ts",
  "apps/server/src/http.ts",
  "packages/contracts/src/rpc.ts",
  "packages/contracts/src/index.ts",
  "apps/server/src/auth/RpcAuthorization.ts",
  "apps/server/src/mcp/McpHttpServer.ts",
  "apps/server/src/mcp/McpInvocationContext.ts",
];

export const LEDGER_HEADER = ["path", "origin", "kind", "ourLines", "targetPR", "status", "reason"];
export const REGISTRY_HEADER = ["path", "target", "statusAfterB1", "rule", "flag", "reason"];
export const SUPERSEDED_HEADER = ["sha", "subject", "proof"];
export const ASSIGNMENT_HEADER = [
  "path",
  "kind",
  "ourLines",
  "group",
  "targetPR",
  "statusAfterB1",
  "rule",
  "flag",
  "reason",
];

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const DEFAULT_REGISTRY_PATH = NodePath.join(HERE, "v2-port-targets.tsv");
export const DEFAULT_SUPERSEDED_PATH = NodePath.join(HERE, "v2-superseded-commits.tsv");

/** The review group a path belongs to, used by the assignments file. */
export const groupFor = (path) => {
  if (path.startsWith("apps/desktop/")) return "apps/desktop";
  if (path.startsWith("apps/mobile/")) return "apps/mobile";
  if (path.startsWith("apps/server/integration/")) return "apps/server/integration";
  if (path.startsWith("apps/server/scripts/")) return "apps/server/scripts";
  if (path.startsWith("apps/server/src/")) {
    const rest = path.slice("apps/server/src/".length);
    return rest.includes("/") ? `apps/server/src/${rest.split("/")[0]}` : "apps/server/src (root)";
  }
  if (path.startsWith("infra/relay/")) return "infra/relay";
  if (path.startsWith("packages/")) return `packages/${path.split("/")[1] ?? ""}`;
  if (path.startsWith("scripts/")) return "scripts";
  if (path.startsWith("evals/")) return "evals";
  return path.split("/")[0] ?? "root";
};

/**
 * Area to target PR. DeepSeek is tested before the generic provider prefix so
 * its package can never be swept into C5-C9. B1 means no area matched.
 */
export const targetPrFor = (path) => {
  if (
    path.startsWith("packages/provider-deepseek/") ||
    path.startsWith("apps/server/src/deepseek/")
  ) {
    return "D1-D7";
  }
  if (
    path.startsWith("apps/server/src/personal/") ||
    path.startsWith("packages/contracts/src/personal")
  ) {
    return "3a";
  }
  if (path.startsWith("apps/server/src/orchestration-v2/")) {
    return "C1-C3";
  }
  if (path.startsWith("apps/server/src/provider/") || path.startsWith("packages/provider-")) {
    return "C5-C9";
  }
  if (path.startsWith("apps/web/")) {
    return "phase 4";
  }
  if (path.startsWith("packages/contracts/")) {
    return "A10";
  }
  if (
    path.startsWith("apps/server/src/observability/") ||
    path.startsWith("apps/server/src/persistence/")
  ) {
    return "C10";
  }
  return "B1";
};

export const reasonFor = (kind) => {
  switch (kind) {
    case "modify-delete":
      return "upstream deleted the file; our changes are parked";
    case "content":
      return "upstream side taken; our hunk is parked";
    case "added-broken":
      return "imports a module gone at U; the file is parked whole";
  }
};

/** Parse the target registry. A duplicate path is a hard error. */
export const parseRegistryText = (text) => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("registry is empty");
  const header = lines[0].split("\t");
  if (
    header.length !== REGISTRY_HEADER.length ||
    !REGISTRY_HEADER.every((name, index) => header[index] === name)
  ) {
    throw new Error(`registry header must be: ${REGISTRY_HEADER.join("\t")}`);
  }
  const rows = new Map();
  for (let index = 1; index < lines.length; index += 1) {
    const columns = lines[index].split("\t");
    if (columns.length !== REGISTRY_HEADER.length) {
      throw new Error(`registry line ${index + 1}: expected ${REGISTRY_HEADER.length} columns`);
    }
    const [path, target, statusAfterB1, rule, flag, reason] = columns;
    if (rows.has(path)) throw new Error(`registry line ${index + 1}: duplicate path ${path}`);
    if (!["open", "dropped", "done"].includes(statusAfterB1)) {
      throw new Error(
        `registry line ${index + 1}: statusAfterB1 must be open, dropped or done, got ${statusAfterB1}`,
      );
    }
    rows.set(path, { path, target, statusAfterB1, rule, flag, reason });
  }
  return rows;
};

/** Parse the superseded-commit table. A duplicate sha is a hard error. */
export const parseSupersededText = (text) => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("superseded commits are empty");
  const header = lines[0].split("\t");
  if (
    header.length !== SUPERSEDED_HEADER.length ||
    !SUPERSEDED_HEADER.every((name, index) => header[index] === name)
  ) {
    throw new Error(`superseded header must be: ${SUPERSEDED_HEADER.join("\t")}`);
  }
  const rows = [];
  const seen = new Set();
  for (let index = 1; index < lines.length; index += 1) {
    const columns = lines[index].split("\t");
    if (columns.length !== SUPERSEDED_HEADER.length) {
      throw new Error(`superseded line ${index + 1}: expected ${SUPERSEDED_HEADER.length} columns`);
    }
    const [sha, subject, proof] = columns;
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`superseded line ${index + 1}: sha must be 40 lowercase hex characters`);
    }
    if (seen.has(sha)) throw new Error(`superseded line ${index + 1}: duplicate sha ${sha}`);
    seen.add(sha);
    rows.push({ sha, subject, proof });
  }
  return rows;
};

/** The sha that supersedes a path, from blob equality with the base and our tree. */
export const supersededBy = ({ origin, baseTree, oursTree, commits }) => {
  const baseBlob = baseTree.get(origin);
  const oursBlob = oursTree.get(origin);
  if (baseBlob === undefined || oursBlob === undefined) return null;
  for (const commit of commits) {
    if (commit.parentTree.get(origin) === baseBlob && commit.tree.get(origin) === oursBlob) {
      return commit.sha;
    }
  }
  return null;
};

/** Parse `git ls-files -u -z` output into stage number to blob hash. */
export const parseUnmergedStages = (text) => {
  const stages = new Map();
  for (const item of text.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    if (tab === -1) continue;
    const [, hash, stage] = item.slice(0, tab).split(" ");
    stages.set(Number(stage), hash);
  }
  return stages;
};

/**
 * The path our change lives at. A path absent from our tree is the destination
 * of an upstream rename; its origin is the one path we own that upstream does
 * not have, with stage 2 as our blob and stage 1 as the base blob. Zero or
 * several candidates fail the run.
 */
export const originFor = ({ path, stages, oursTree, upstreamTree, baseTree }) => {
  if (oursTree.has(path)) return { ok: true, origin: path, candidates: [] };
  const baseBlob = stages.get(1);
  const oursBlob = stages.get(2);
  if (baseBlob === undefined || oursBlob === undefined) {
    return { ok: true, origin: path, candidates: [] };
  }
  const candidates = [...oursTree.keys()]
    .filter(
      (candidate) =>
        !upstreamTree.has(candidate) &&
        oursTree.get(candidate) === oursBlob &&
        baseTree.get(candidate) === baseBlob,
    )
    .sort();
  if (candidates.length === 1) return { ok: true, origin: candidates[0], candidates };
  return { ok: false, origin: path, candidates };
};

/** True when a patch carries at least one hunk. */
export const hasHunks = (patch) => patch.split("\n").some((line) => line.startsWith("@@"));

const V1_STUB_PATTERN =
  /getPendingInputActivities|validateTurn|prewarmSession|PersonalBotRepository|PersonalVoiceCallRepository|Layer\.provideMerge/;

/** One added line that only stubs a v1 service, comments, or closes a block. */
export const isV1StubLine = (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return true;
  if (/^[)\]};,]+$/.test(trimmed)) return true;
  return V1_STUB_PATTERN.test(trimmed);
};

/** A test or integration file whose every added line is a v1 stub. */
export const isV1StubPatch = ({ path, patch }) => {
  if (!path.endsWith(".test.ts") && !path.includes("/integration/")) return false;
  const added = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  return added.length > 0 && added.every(isV1StubLine);
};

/** The source files a test path may take its target from, best match first. */
export const followSourceCandidates = (path) => {
  const candidates = [];
  if (path.endsWith(".test.ts")) {
    candidates.push(path.slice(0, -".test.ts".length) + ".ts");
    const caseMatch = /^(.*)\.[A-Za-z0-9_-]+\.test\.ts$/.exec(path);
    if (caseMatch !== null) candidates.push(`${caseMatch[1]}.ts`);
  }
  const testPrefix = "apps/server/test/";
  if (path.startsWith(testPrefix)) {
    const base = path.slice(testPrefix.length).replace(/\.test\.ts$/, ".ts");
    candidates.push(`apps/server/src/orchestration/${base}`);
  }
  return [...new Set(candidates)];
};

/** Rule 4: a test follows the registry entry of the source it names. */
export const followSourceTarget = (path, registry) => {
  const candidates = followSourceCandidates(path);
  for (const candidate of candidates) {
    const direct = registry.get(candidate);
    if (direct !== undefined) return direct;
  }
  const names = new Set(candidates.map((candidate) => NodePath.basename(candidate)));
  const matches = [...registry.values()].filter((row) => names.has(NodePath.basename(row.path)));
  return matches.length === 1 ? matches[0] : undefined;
};

/**
 * Rule 1: every non-merge commit on our side touching the path is an upstream
 * cherry-pick whose subject also appears in MB..U. No commit is not evidence.
 */
export const isBackport = ({ repo, mergeBase, ours, path, upstreamSubjects }) => {
  const subjects = NodeChildProcess.execFileSync(
    "git",
    ["-C", repo, "log", "--no-merges", "--format=%s", `${mergeBase}..${ours}`, "--", path],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  )
    .split("\n")
    .filter((line) => line.length > 0);
  return backportMatches(subjects, upstreamSubjects);
};

/** The pure half of rule 1: every commit is an upstream cherry-pick. */
export const backportMatches = (subjects, upstreamSubjects) =>
  subjects.length > 0 &&
  subjects.every((subject) => /\(#\d+\)$/.test(subject) && upstreamSubjects.has(subject));

/**
 * The ordered target rules. `backport` is computed by the caller because it
 * needs git; everything else is pure so a fixture can drive it.
 */
export const targetFor = ({
  path,
  origin = path,
  patch,
  registry,
  backport,
  superseded = null,
  supersededCreated = null,
}) => {
  if (backport) {
    return {
      target: "B1",
      status: "dropped",
      rule: "backport",
      flag: "",
      reason: "every commit on our side is an upstream cherry-pick U already has",
    };
  }
  if (superseded !== null) {
    if (supersededCreated !== null && supersededCreatedBlocksDrop(supersededCreated)) {
      return null;
    }
    return {
      target: "B1",
      status: "dropped",
      rule: "superseded",
      flag: "",
      reason: `our only change at this path is ${superseded}, which U already carries`,
    };
  }
  const registered = registry.get(path) ?? registry.get(origin);
  if (registered !== undefined) {
    return {
      target: registered.target,
      status: registered.statusAfterB1,
      rule: "registry",
      flag: registered.flag,
      reason: registered.reason,
    };
  }
  if (patch !== null && isV1StubPatch({ path: origin, patch })) {
    return {
      target: "B1",
      status: "dropped",
      rule: "v1-stub",
      flag: "",
      reason: "our added lines only stub v1 service methods in an upstream test",
    };
  }
  const followed = followSourceTarget(path, registry);
  if (followed !== undefined) {
    return {
      target: followed.target,
      status: followed.statusAfterB1,
      rule: "follow-source",
      flag: followed.flag,
      reason: `follows ${followed.path}`,
    };
  }
  const area = targetPrFor(path);
  if (area !== "B1") {
    return {
      target: area,
      status: "open",
      rule: "area",
      flag: "",
      reason: `area ${area}`,
    };
  }
  return null;
};

/**
 * Plan for one unmerged path. Pure so the fixtures can drive every rule.
 * `broken` is only consulted for add/add, where our file is still a candidate
 * to keep.
 */
export const planFor = ({ status, seam, broken, apply = false }) => {
  if (seam) {
    return apply ? { action: "take-upstream", kind: null } : { action: "leave-seam", kind: null };
  }
  if (status === "UD") {
    return { action: "take-deletion", kind: "modify-delete" };
  }
  if (status === "AA") {
    return broken
      ? { action: "remove-added", kind: "added-broken" }
      : { action: "take-upstream", kind: "content" };
  }
  if (status === "UU" || status === "DU") {
    return { action: "take-upstream", kind: "content" };
  }
  if (status === "AU") {
    return { action: "keep-ours", kind: null };
  }
  if (status === "UA") {
    return { action: "take-upstream", kind: null };
  }
  return { action: "unclassified", kind: null };
};

/** Count added lines in a unified diff, ignoring the file header. */
export const countPatchLines = (patch) =>
  patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;

/**
 * Our files that sit under orchestration/ at ours and reappear with identical
 * content under orchestration-v2/ in the merge result. Directory rename
 * detection is off, so this must be zero.
 */
export const renamedIntoV2 = (oursTree, resultTree) => {
  const bySuffix = new Map();
  for (const [path, hash] of oursTree) {
    const prefix = "apps/server/src/orchestration/";
    if (path.startsWith(prefix)) {
      bySuffix.set(path.slice(prefix.length), hash);
    }
  }
  const pairs = [];
  for (const [path, hash] of resultTree) {
    const prefix = "apps/server/src/orchestration-v2/";
    if (path.startsWith(prefix) && bySuffix.get(path.slice(prefix.length)) === hash) {
      pairs.push(path);
    }
  }
  return pairs;
};

const importsIn = (source) =>
  [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((match) => match[1]);

/**
 * True when a file imports a module that existed at ours and will not exist in
 * the merged tree. An import that never resolved (an asset, a bare package
 * name) is not evidence.
 */
export const hasBrokenImport = ({ file, source, files, oursFiles }) =>
  importsIn(source).some((spec) => {
    if (!spec.startsWith(".") && !spec.startsWith("@t3tools/contracts/")) return false;
    return (
      resolveImportTarget(file, spec, files) === null &&
      resolveImportTarget(file, spec, oursFiles) !== null
    );
  });

const git = (repo, args, options = {}) =>
  NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
    ...options,
  });

const tryGit = (repo, args) => {
  try {
    return { ok: true, stdout: git(repo, args) };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
  }
};

const listTree = (repo, ref) => {
  const out = git(repo, ["ls-tree", "-r", "-z", ref]);
  const entries = new Map();
  for (const item of out.split("\0")) {
    if (!item) continue;
    const tab = item.indexOf("\t");
    const path = item.slice(tab + 1);
    const hash = item.slice(0, tab).split(" ")[2];
    entries.set(path, hash);
  }
  return entries;
};

const statusEntries = (repo) => {
  const raw = git(repo, ["status", "--porcelain=v1", "-z"]);
  const parts = raw.split("\0");
  const entries = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item) continue;
    const xy = item.slice(0, 2);
    const path = item.slice(3);
    entries.push({ xy, path });
    if (xy.startsWith("R") || xy.startsWith("C")) {
      index += 1;
    }
  }
  return entries;
};

const writePatch = (dir, path, text) => {
  const target = NodePath.join(dir, "patches", `${path}.patch`);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, text.endsWith("\n") ? text : `${text}\n`);
};

const ourPatch = (repo, base, ours, origin) => {
  const result = tryGit(repo, ["diff", "--no-color", "--full-index", base, ours, "--", origin]);
  return result.ok ? result.stdout : "";
};

const addedFilePatch = (repo, ours, path) => {
  const result = tryGit(repo, ["show", `${ours}:${path}`]);
  if (!result.ok) return "";
  const body = result.stdout
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${result.stdout.split("\n").length - 1} @@\n${body}`;
};

/**
 * H.4 check 1, closure. A parked file may not keep a live importer. `importers`
 * maps a parked path to the files that import it; a seam may import a personal
 * module because its one registration line is the seam.
 */
export const closureErrors = ({ parkedPaths, importers, seams = SEAM_FILES }) => {
  const parked = new Set(parkedPaths);
  const errors = [];
  for (const target of parked) {
    for (const importer of importers.get(target) ?? []) {
      if (parked.has(importer) || seams.includes(importer)) continue;
      errors.push(`${importer} imports parked ${target}`);
    }
  }
  return errors;
};

/** Every export a parked hunk removes, from its `-` lines. */
export const removedExportNames = (patch) => {
  const names = new Set();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("-") || line.startsWith("---")) continue;
    const declared = line.match(
      /^-\s*export\s+(?:declare\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declared) names.add(declared[1]);
    const listed = line.match(/^-\s*export\s*\{([^}]*)\}/);
    if (listed) {
      for (const part of listed[1].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop();
        if (name) names.add(name);
      }
    }
  }
  return [...names];
};

/**
 * H.4 check 2, strip detector. A removed export may not leave a live caller
 * outside the parked set.
 */
export const stripErrors = ({ removed, sources, parkedPaths }) => {
  const parked = new Set(parkedPaths);
  const errors = [];
  for (const [name, definingPath] of removed) {
    const pattern = new RegExp(`\\b${name}\\b`);
    for (const [path, source] of sources) {
      if (path === definingPath || parked.has(path) || SEAM_FILES.includes(path)) continue;
      if (pattern.test(source))
        errors.push(`${name} is stripped at ${definingPath} but ${path} still reads it`);
    }
  }
  return errors;
};

/**
 * H.4 check 3, clean-merge hunks. A U file that merged clean and still differs
 * from U carries one of our hunks; it must be a ledger row or a seam.
 */
export const cleanMergeHunkErrors = ({
  changedPaths,
  upstreamFiles,
  parkedPaths,
  seams = SEAM_FILES,
}) => {
  const parked = new Set(parkedPaths);
  return changedPaths.filter(
    (path) => upstreamFiles.has(path) && !parked.has(path) && !seams.includes(path),
  );
};

/**
 * H.4 check 4, superseded-created files. A file the superseded commit created
 * may drop only when U carries the path or no live importer remains.
 */
export const supersededCreatedBlocksDrop = ({ created, upstreamHas, liveImporters }) =>
  created && !upstreamHas && liveImporters.length > 0;

const exportedNamesOnRemovedLines = (diff) => {
  const names = new Set();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("-") || line.startsWith("---")) continue;
    const declared = line.match(
      /^-\s*(?:export\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declared) names.add(declared[1]);
    const listed = line.match(/^-\s*export\s*\{([^}]*)\}/);
    if (listed) {
      for (const part of listed[1].split(",")) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop();
        if (name) names.add(name);
      }
    }
  }
  return [...names];
};

/**
 * H.4 check 5, seam types. A seam diff may add lines but may not remove or
 * change a name a U test reads. A private local that no test names may go.
 */
export const seamTypeErrors = ({ path, diff, sources }) => {
  const tests = [...sources].filter(
    ([testPath]) =>
      testPath !== path && /(\.test\.tsx?$|\.integration\.ts$|\/integration\/)/.test(testPath),
  );
  const errors = [];
  for (const name of exportedNamesOnRemovedLines(diff)) {
    const pattern = new RegExp(`\\b${name}\\b`);
    const reader = tests.find(([, source]) => pattern.test(source));
    if (reader !== undefined) errors.push(`${path} changes ${name}, which ${reader[0]} reads`);
  }
  return errors;
};

/** Source text of the merged tree (tracked plus lever-added untracked files). */
export const readMergedSources = (repo) => {
  const listed = git(repo, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "*.ts",
    "*.tsx",
  ]);
  const sources = new Map();
  for (const path of listed.split("\n")) {
    if (!path) continue;
    if (
      !/^(apps\/server\/src\/|apps\/server\/integration\/|packages\/contracts\/src\/|packages\/shared\/src\/|scripts\/personal\/)/.test(
        path,
      )
    ) {
      continue;
    }
    let text;
    try {
      text = NodeFS.readFileSync(NodePath.join(repo, path), "utf8");
    } catch {
      continue;
    }
    if (text.includes("<<<<<<<")) continue;
    sources.set(path, text);
  }
  return sources;
};

/** Reverse import edges for the merged tree. */
export const importersByTarget = (sources) => {
  const files = new Set(sources.keys());
  const importers = new Map();
  for (const [path, source] of sources) {
    for (const spec of importsIn(source)) {
      if (!spec.startsWith(".") && !spec.startsWith("@t3tools/contracts/")) continue;
      const target = resolveImportTarget(path, spec, files);
      if (target === null) continue;
      const list = importers.get(target) ?? [];
      if (!list.includes(path)) list.push(path);
      importers.set(target, list);
    }
  }
  return importers;
};

/** Live importers of one path at a ref (check 4, before the result tree exists). */
const liveImportersAt = ({ repo, ref, path, tree }) => {
  const base = NodePath.basename(path).replace(/\.tsx?$/, "");
  const matches = tryGit(repo, ["grep", "-l", "-F", base, ref, "--", "*.ts", "*.tsx"]);
  if (!matches.ok) return [];
  const importers = [];
  for (const match of matches.stdout.split("\n")) {
    const colon = match.indexOf(":");
    if (colon === -1) continue;
    const importer = match.slice(colon + 1);
    if (importer === path) continue;
    const source = tryGit(repo, ["show", `${ref}:${importer}`]);
    if (!source.ok) continue;
    const resolves = importsIn(source.stdout).some(
      (spec) =>
        (spec.startsWith(".") || spec.startsWith("@t3tools/contracts/")) &&
        resolveImportTarget(importer, spec, tree) === path,
    );
    if (resolves) importers.push(importer);
  }
  return importers;
};

/** Runs checks 1, 2, 3 and 5 against the applied tree. */
export const h4CheckErrors = ({ repo, theirs, theirsTree, rows, ledger }) => {
  const sources = readMergedSources(repo);
  const parkedPaths = rows.map((row) => row.path);
  const importers = importersByTarget(sources);
  const errors = [...closureErrors({ parkedPaths, importers })];
  const removed = new Map();
  for (const row of rows) {
    const patchPath = NodePath.join(ledger, "patches", `${row.path}.patch`);
    let patch = "";
    try {
      patch = NodeFS.readFileSync(patchPath, "utf8");
    } catch {
      continue;
    }
    for (const name of removedExportNames(patch)) removed.set(name, row.path);
  }
  errors.push(...stripErrors({ removed, sources, parkedPaths }));
  const changed = tryGit(repo, ["diff", "--cached", "--name-only", theirs])
    .stdout.split("\n")
    .filter(Boolean);
  errors.push(
    ...cleanMergeHunkErrors({ changedPaths: changed, upstreamFiles: theirsTree, parkedPaths }).map(
      (path) => `${path} merged clean from U but still carries our hunk`,
    ),
  );
  for (const path of SEAM_FILES) {
    const diff = tryGit(repo, ["diff", "--cached", theirs, "--", path]).stdout;
    if (diff.length === 0) continue;
    errors.push(...seamTypeErrors({ path, diff, sources }));
  }
  return errors;
};

const parseArgs = (argv) => {
  const options = {
    repo: null,
    ours: "HEAD",
    theirs: null,
    base: null,
    ledger: null,
    registry: DEFAULT_REGISTRY_PATH,
    superseded: DEFAULT_SUPERSEDED_PATH,
    assignments: null,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (
      ![
        "--repo",
        "--ours",
        "--theirs",
        "--base",
        "--ledger",
        "--registry",
        "--superseded",
        "--assignments",
      ].includes(arg)
    ) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const next = argv[index + 1];
    if (next === undefined) {
      throw new Error(`${arg} needs a value`);
    }
    options[arg.slice(2)] = next;
    index += 1;
  }
  if (options.repo === null) throw new Error("--repo is required");
  if (options.theirs === null) throw new Error("--theirs is required");
  options.repo = NodePath.resolve(options.repo);
  if (options.ledger === null) {
    options.ledger = NodePath.join(options.repo, "scripts/personal/sync/v2-port-ledger");
  }
  options.ledger = NodePath.resolve(options.ledger);
  options.registry = NodePath.resolve(options.registry);
  options.superseded = NodePath.resolve(options.superseded);
  if (options.assignments !== null) options.assignments = NodePath.resolve(options.assignments);
  return options;
};

const main = () => {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`v2-merge-resolve: ${error.message}`);
    process.exit(2);
  }

  const { repo, ours, theirs, ledger, apply } = options;
  const dirty = git(repo, ["status", "--porcelain"]);
  if (dirty.trim().length > 0) {
    console.error("v2-merge-resolve: worktree must be clean before the merge");
    process.exit(2);
  }

  let oursSha;
  let theirsSha;
  try {
    oursSha = git(repo, ["rev-parse", `${ours}^{commit}`]).trim();
    theirsSha = git(repo, ["rev-parse", `${theirs}^{commit}`]).trim();
  } catch (error) {
    console.error(`v2-merge-resolve: cannot resolve refs: ${error.message}`);
    process.exit(2);
  }

  let mergeBase;
  try {
    mergeBase =
      options.base === null
        ? git(repo, ["merge-base", oursSha, theirsSha]).trim()
        : git(repo, ["rev-parse", `${options.base}^{commit}`]).trim();
  } catch (error) {
    console.error(`v2-merge-resolve: cannot resolve the merge base: ${error.message}`);
    process.exit(2);
  }

  let registry;
  try {
    registry = parseRegistryText(NodeFS.readFileSync(options.registry, "utf8"));
  } catch (error) {
    console.error(`v2-merge-resolve: ${error.message}`);
    process.exit(2);
  }

  let supersededCommits;
  try {
    supersededCommits = parseSupersededText(NodeFS.readFileSync(options.superseded, "utf8")).map(
      (row) => ({
        sha: row.sha,
        tree: listTree(repo, row.sha),
        parentTree: listTree(repo, `${row.sha}^`),
      }),
    );
  } catch (error) {
    console.error(`v2-merge-resolve: ${error.message}`);
    process.exit(2);
  }

  const upstreamSubjects = new Set(
    git(repo, ["log", "--no-merges", "--format=%s", `${mergeBase}..${theirsSha}`])
      .split("\n")
      .filter((line) => line.length > 0),
  );

  const oursTree = listTree(repo, oursSha);
  const upstreamTree = listTree(repo, theirsSha);
  const baseTree = listTree(repo, mergeBase);

  const merge = tryGit(repo, [
    "-c",
    "merge.directoryRenames=false",
    "-c",
    "rerere.enabled=false",
    "-c",
    "user.name=v2-merge-resolve",
    "-c",
    "user.email=v2-merge-resolve@localhost",
    "merge",
    "--no-commit",
    "--no-edit",
    theirsSha,
  ]);
  if (merge.ok) {
    console.log(`v2-merge-resolve: merge is clean at ${theirsSha}; nothing to park`);
    process.exit(0);
  }
  if (!tryGit(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
    console.error("v2-merge-resolve: git merge failed without leaving a merge in progress");
    if (merge.stderr.trim().length > 0) console.error(merge.stderr.trim());
    process.exit(2);
  }

  const entries = statusEntries(repo);
  const unmerged = entries.filter((entry) =>
    ["UU", "AA", "UD", "DU", "AU", "UA"].includes(entry.xy),
  );

  // The file set an import may resolve against after the merge: upstream's
  // tree plus the files only we added.
  const oursAdded = new Set(
    [...oursTree.keys()].filter((path) => !baseTree.has(path) && !upstreamTree.has(path)),
  );
  const candidateFiles = new Set([...upstreamTree.keys(), ...oursAdded]);

  const rows = [];
  const leftSeam = [];
  const unclassified = [];
  const unmatched = [];
  const zeroHunk = [];
  const originFailures = [];

  const assign = (entry, kind, patch, origin = entry.path) => {
    const backport = isBackport({
      repo,
      mergeBase,
      ours: oursSha,
      path: origin,
      upstreamSubjects,
    });
    const superseded =
      kind === "added-broken"
        ? null
        : supersededBy({ origin, baseTree, oursTree, commits: supersededCommits });
    const supersededCreated =
      superseded === null
        ? null
        : (() => {
            const created = !baseTree.has(origin) && oursTree.has(origin);
            return {
              created,
              upstreamHas: upstreamTree.has(origin),
              liveImporters: created
                ? liveImportersAt({ repo, ref: oursSha, path: origin, tree: oursTree })
                : [],
            };
          })();
    const assignment = targetFor({
      path: entry.path,
      origin,
      patch,
      registry,
      backport,
      superseded,
      supersededCreated,
    });
    if (assignment === null) {
      unmatched.push(entry.path);
      return;
    }
    if (assignment.target === "B1" && assignment.status === "open") {
      unmatched.push(entry.path);
      return;
    }
    if (kind !== "added-broken" && !hasHunks(patch)) {
      zeroHunk.push(entry.path);
      return;
    }
    writePatch(ledger, entry.path, patch);
    rows.push({
      path: entry.path,
      origin: origin === entry.path ? "" : origin,
      group: groupFor(entry.path),
      kind,
      ourLines: countPatchLines(patch),
      targetPR: assignment.target,
      status: assignment.status,
      rule: assignment.rule,
      flag: assignment.flag,
      reason: assignment.reason,
    });
  };

  for (const entry of unmerged) {
    const seam = SEAM_FILES.includes(entry.path);
    let broken = false;
    if (entry.xy === "AA" && !seam) {
      const stage = tryGit(repo, ["show", `:2:${entry.path}`]);
      broken =
        stage.ok &&
        hasBrokenImport({
          file: entry.path,
          source: stage.stdout,
          files: candidateFiles,
          oursFiles: oursTree,
        });
    }
    const plan = planFor({ status: entry.xy, path: entry.path, seam, broken, apply });

    // Read the merge stages before resolving the file: the file actions below
    // remove or replace the index entries these hashes come from.
    let origin = entry.path;
    let patch = null;
    if (plan.kind === "added-broken") {
      patch = addedFilePatch(repo, oursSha, entry.path);
    } else if (plan.kind !== null) {
      const stages = parseUnmergedStages(git(repo, ["ls-files", "-u", "-z", "--", entry.path]));
      const resolved = originFor({
        path: entry.path,
        stages,
        oursTree,
        upstreamTree,
        baseTree,
      });
      if (resolved.ok) {
        origin = resolved.origin;
        patch = ourPatch(repo, mergeBase, oursSha, origin);
      } else {
        originFailures.push({ path: entry.path, candidates: resolved.candidates });
      }
    }

    switch (plan.action) {
      case "leave-seam":
        leftSeam.push(entry.path);
        break;
      case "take-deletion":
        git(repo, ["rm", "-q", "-f", "--", entry.path]);
        break;
      case "take-upstream":
        git(repo, ["checkout", "--theirs", "--", entry.path]);
        git(repo, ["add", "--", entry.path]);
        break;
      case "keep-ours":
        git(repo, ["add", "--", entry.path]);
        break;
      case "remove-added":
        git(repo, ["rm", "-q", "-f", "--", entry.path]);
        break;
      default:
        unclassified.push(entry.path);
    }

    if (patch !== null) assign(entry, plan.kind, patch, origin);
  }

  // Rule 3 continues after the conflicts: a file we added can survive the
  // merge cleanly and still import a module upstream deleted. Resolve the
  // import graph to a fixpoint in memory, then remove and park each file once.
  const mergedFiles = new Set(git(repo, ["ls-files"]).split("\n").filter(Boolean));
  const edges = new Map();
  for (const path of oursAdded) {
    if (!mergedFiles.has(path)) continue;
    const source = tryGit(repo, ["show", `HEAD:${path}`]);
    if (!source.ok) continue;
    const targets = [];
    for (const spec of importsIn(source.stdout)) {
      if (!spec.startsWith(".") && !spec.startsWith("@t3tools/contracts/")) continue;
      const target = resolveImportTarget(path, spec, oursTree);
      if (target !== null) targets.push(target);
    }
    edges.set(path, targets);
  }
  const survivors = new Set(edges.keys());
  let shrinking = true;
  while (shrinking) {
    shrinking = false;
    for (const path of [...survivors].sort()) {
      const broken = edges
        .get(path)
        .some((target) => !mergedFiles.has(target) && !survivors.has(target));
      if (!broken) continue;
      survivors.delete(path);
      shrinking = true;
    }
  }
  for (const path of [...edges.keys()].filter((path) => !survivors.has(path)).sort()) {
    git(repo, ["rm", "-q", "-f", "--", path]);
    const patch = addedFilePatch(repo, oursSha, path);
    assign({ path }, "added-broken", patch);
  }

  // Names that upstream owns under orchestration-v2 plus our same-content
  // orchestration files would be the silent relocation this resolver exists to
  // prevent.
  const resultTree = new Map();
  for (const line of git(repo, ["ls-files", "-s"]).split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    resultTree.set(path, meta.split(" ")[1]);
  }
  const relocated = renamedIntoV2(oursTree, resultTree);
  const h4 = apply
    ? h4CheckErrors({
        repo,
        theirs: theirsSha,
        theirsTree: upstreamTree,
        rows,
        ledger,
      })
    : [];

  const rowsSorted = [...rows].sort((left, right) => left.path.localeCompare(right.path));
  NodeFS.mkdirSync(NodePath.join(ledger, "patches"), { recursive: true });
  const ledgerText = [
    LEDGER_HEADER.join("\t"),
    ...rowsSorted.map((row) =>
      [
        row.path,
        row.origin,
        row.kind,
        String(row.ourLines),
        row.targetPR,
        row.status,
        row.reason,
      ].join("\t"),
    ),
    "",
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(ledger, "ledger.tsv"), ledgerText);

  if (options.assignments !== null) {
    const assignmentText = [
      ASSIGNMENT_HEADER.join("\t"),
      ...rowsSorted.map((row) =>
        [
          row.path,
          row.kind,
          String(row.ourLines),
          row.group,
          row.targetPR,
          row.status,
          row.rule,
          row.flag,
          row.reason,
        ].join("\t"),
      ),
      "",
    ].join("\n");
    NodeFS.writeFileSync(options.assignments, assignmentText);
  }

  const remaining = statusEntries(repo).filter((entry) =>
    ["UU", "AA", "UD", "DU", "AU", "UA"].includes(entry.xy),
  );
  const remainingNonSeam = remaining.filter((entry) => !SEAM_FILES.includes(entry.path));

  const byKind = rowsSorted.reduce((counts, row) => {
    counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    return counts;
  }, {});
  const byRule = rowsSorted.reduce((counts, row) => {
    counts[row.rule] = (counts[row.rule] ?? 0) + 1;
    return counts;
  }, {});
  const openAtB1 = rowsSorted.filter(
    (row) => row.targetPR === "B1" && row.status === "open",
  ).length;

  console.log(`v2-merge-resolve: ${apply ? "apply" : "dry run"}`);
  console.log(`  ours      ${ours} ${oursSha}`);
  console.log(`  theirs    ${theirs} ${theirsSha}`);
  console.log(`  base      ${mergeBase}${options.base === null ? " (merge-base)" : ""}`);
  console.log(
    `  conflicts ${unmerged.length} (${[...new Set(unmerged.map((entry) => entry.xy))].sort().join(", ")})`,
  );
  console.log(`  renamed into orchestration-v2: ${relocated.length}`);
  for (const path of relocated.slice(0, 20)) console.log(`    ${path}`);
  console.log(`  renamed origins: ${rowsSorted.filter((row) => row.origin !== "").length}`);
  console.log(`  ledger    ${NodePath.join(ledger, "ledger.tsv")} (${rowsSorted.length} rows)`);
  for (const kind of ["modify-delete", "content", "added-broken"]) {
    console.log(`    ${kind}: ${byKind[kind] ?? 0}`);
  }
  for (const rule of ["backport", "superseded", "registry", "v1-stub", "follow-source", "area"]) {
    console.log(`    ${rule}: ${byRule[rule] ?? 0}`);
  }
  console.log(`  open at B1: ${openAtB1}`);
  console.log(`  h.4 checks: ${h4.length}`);
  for (const error of h4) console.log(`    ${error}`);
  console.log(`  unmatched: ${unmatched.length}`);
  for (const path of unmatched) console.log(`    ${path}`);
  console.log(`  empty patches: ${zeroHunk.length}`);
  for (const path of zeroHunk) console.log(`    ${path}`);
  if (originFailures.length > 0) {
    console.log(`  rename origins not unique: ${originFailures.length}`);
    for (const failure of originFailures) {
      console.log(`    ${failure.path} candidates=${failure.candidates.length}`);
      for (const candidate of failure.candidates) console.log(`      ${candidate}`);
    }
  }
  console.log(`  seam left for hand resolution: ${leftSeam.length}`);
  for (const path of leftSeam.sort()) console.log(`    ${path}`);
  if (unclassified.length > 0) {
    console.log(`  unclassified: ${unclassified.length}`);
    for (const path of unclassified) console.log(`    ${path}`);
  }

  const failed =
    relocated.length > 0 ||
    unclassified.length > 0 ||
    remainingNonSeam.length > 0 ||
    unmatched.length > 0 ||
    zeroHunk.length > 0 ||
    originFailures.length > 0 ||
    h4.length > 0;
  if (remainingNonSeam.length > 0) {
    console.error("v2-merge-resolve: non-seam conflicts remain:");
    for (const entry of remainingNonSeam) console.error(`  ${entry.xy} ${entry.path}`);
  }
  if (unmatched.length > 0) {
    console.error("v2-merge-resolve: rows with no target (B1 open is not a target):");
    for (const path of unmatched) console.error(`  ${path}`);
  }
  if (zeroHunk.length > 0) {
    console.error("v2-merge-resolve: content or modify-delete rows with an empty patch:");
    for (const path of zeroHunk) console.error(`  ${path}`);
  }
  if (originFailures.length > 0) {
    console.error("v2-merge-resolve: rename origin is not unique:");
    for (const failure of originFailures) {
      console.error(`  ${failure.path} (${failure.candidates.length} candidates)`);
      for (const candidate of failure.candidates) console.error(`    ${candidate}`);
    }
  }
  if (h4.length > 0) {
    console.error("v2-merge-resolve: H.4 checks failed:");
    for (const error of h4) console.error(`  ${error}`);
  }
  process.exit(failed ? 1 : 0);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main();
}
