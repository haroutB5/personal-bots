// v2 merge resolver. Applies the B1 rules to a real merge and parks every
// personal hunk in the ledger instead of losing it.
//
//   node scripts/personal/sync/v2-merge-resolve.mjs --repo <clone> --ours <branch-or-sha> \
//     --theirs <upstream-ref> --base <sha> --ledger <dir> [--apply]
//
// Run it in a throwaway clone, never on a real branch. Without --apply the
// six seam files stay unmerged for a human; with --apply they take upstream's
// side and the report lists the registration lines to re-add.
//
// Rules, in order (design section 4, B1):
//   1. merge.directoryRenames=false
//   2. modify-delete: take the deletion, park our diff
//   3. our added files that no longer compile: remove, park the whole file
//   4. content conflicts outside the seam: take upstream, park our hunk
//   5. seam allowlist: take upstream, then re-add our one registration line
//   6. migrations: resolve-migrations.ts (the caller runs it)
//
// Exit codes: 0 dry run resolved as far as it can, 1 unresolvable conflict or
// a renamed-into-v2 path, 2 usage or git error.
import { execFileSync } from "node:child_process";
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
];

export const LEDGER_HEADER = ["path", "kind", "ourLines", "targetPR", "status", "reason"];

/** Area to target PR. Anything unmapped parks at B1, which is where a human triages it. */
export const targetPrFor = (path) => {
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
  if (
    path.startsWith("packages/provider-deepseek/") ||
    path.startsWith("apps/server/src/deepseek/")
  ) {
    return "D1-D7";
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

/**
 * Plan for one unmerged path. Pure so the fixtures can drive every rule.
 * `broken` is only consulted for add/add, where our file is still a candidate
 * to keep.
 */
export const planFor = ({ status, path, seam, broken, apply = false }) => {
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
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28, ...options });

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

const ourPatch = (repo, base, ours, path) => {
  const result = tryGit(repo, ["diff", "--no-color", base, ours, "--", path]);
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

const parseArgs = (argv) => {
  const options = {
    repo: null,
    ours: "HEAD",
    theirs: null,
    base: "2679d279ce",
    ledger: null,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (!["--repo", "--ours", "--theirs", "--base", "--ledger"].includes(arg)) {
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

  const { repo, ours, theirs, base, ledger, apply } = options;
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

  const oursTree = listTree(repo, oursSha);
  const upstreamTree = listTree(repo, theirsSha);
  const baseTree = listTree(repo, base);

  const merge = tryGit(repo, [
    "-c",
    "merge.directoryRenames=false",
    "-c",
    "rerere.enabled=false",
    "merge",
    "--no-commit",
    "--no-edit",
    theirsSha,
  ]);
  if (merge.ok) {
    console.log(`v2-merge-resolve: merge is clean at ${theirsSha}; nothing to park`);
    process.exit(0);
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

    if (plan.kind !== null) {
      const patch =
        plan.kind === "added-broken"
          ? addedFilePatch(repo, oursSha, entry.path)
          : ourPatch(repo, base, oursSha, entry.path);
      writePatch(ledger, entry.path, patch);
      rows.push({
        path: entry.path,
        kind: plan.kind,
        ourLines: countPatchLines(patch),
        targetPR: targetPrFor(entry.path),
        status: "open",
        reason: reasonFor(plan.kind),
      });
    }
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
    writePatch(ledger, path, patch);
    rows.push({
      path,
      kind: "added-broken",
      ourLines: countPatchLines(patch),
      targetPR: targetPrFor(path),
      status: "open",
      reason: reasonFor("added-broken"),
    });
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

  const rowsSorted = [...rows].sort((left, right) => left.path.localeCompare(right.path));
  NodeFS.mkdirSync(NodePath.join(ledger, "patches"), { recursive: true });
  const ledgerText = [
    LEDGER_HEADER.join("\t"),
    ...rowsSorted.map((row) =>
      [row.path, row.kind, String(row.ourLines), row.targetPR, row.status, row.reason].join("\t"),
    ),
    "",
  ].join("\n");
  NodeFS.writeFileSync(NodePath.join(ledger, "ledger.tsv"), ledgerText);

  const remaining = statusEntries(repo).filter((entry) =>
    ["UU", "AA", "UD", "DU", "AU", "UA"].includes(entry.xy),
  );
  const remainingNonSeam = remaining.filter((entry) => !SEAM_FILES.includes(entry.path));

  const byKind = rowsSorted.reduce((counts, row) => {
    counts[row.kind] = (counts[row.kind] ?? 0) + 1;
    return counts;
  }, {});

  console.log(`v2-merge-resolve: ${apply ? "apply" : "dry run"}`);
  console.log(`  ours      ${ours} ${oursSha}`);
  console.log(`  theirs    ${theirs} ${theirsSha}`);
  console.log(`  base      ${base}`);
  console.log(
    `  conflicts ${unmerged.length} (${[...new Set(unmerged.map((entry) => entry.xy))].sort().join(", ")})`,
  );
  console.log(`  renamed into orchestration-v2: ${relocated.length}`);
  for (const path of relocated.slice(0, 20)) console.log(`    ${path}`);
  console.log(`  ledger    ${NodePath.join(ledger, "ledger.tsv")} (${rowsSorted.length} rows)`);
  for (const kind of ["modify-delete", "content", "added-broken"]) {
    console.log(`    ${kind}: ${byKind[kind] ?? 0}`);
  }
  console.log(`  seam left for hand resolution: ${leftSeam.length}`);
  for (const path of leftSeam.sort()) console.log(`    ${path}`);
  if (unclassified.length > 0) {
    console.log(`  unclassified: ${unclassified.length}`);
    for (const path of unclassified) console.log(`    ${path}`);
  }

  const failed = relocated.length > 0 || unclassified.length > 0 || remainingNonSeam.length > 0;
  if (remainingNonSeam.length > 0) {
    console.error("v2-merge-resolve: non-seam conflicts remain:");
    for (const entry of remainingNonSeam) console.error(`  ${entry.xy} ${entry.path}`);
  }
  process.exit(failed ? 1 : 0);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href
) {
  main();
}
