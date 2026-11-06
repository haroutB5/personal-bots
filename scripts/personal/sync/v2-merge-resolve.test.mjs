// Fixtures for the B1 resolver rules. Run:
//   node --test scripts/personal/sync/v2-merge-resolve.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
const { test } = NodeTest;

import {
  backportMatches,
  countPatchLines,
  followSourceTarget,
  groupFor,
  hasBrokenImport,
  hasHunks,
  isV1StubPatch,
  originFor,
  parseRegistryText,
  parseSupersededText,
  parseUnmergedStages,
  planFor,
  renamedIntoV2,
  SEAM_FILES,
  supersededBy,
  targetFor,
  targetPrFor,
} from "./v2-merge-resolve.mjs";

const plan = (overrides) =>
  planFor({ path: "apps/server/src/x.ts", seam: false, broken: false, ...overrides });

test("modify-delete takes the deletion and parks our diff", () => {
  NodeAssert.deepEqual(plan({ status: "UD" }), { action: "take-deletion", kind: "modify-delete" });
});

test("content conflicts outside the seam take upstream", () => {
  NodeAssert.deepEqual(plan({ status: "UU" }), { action: "take-upstream", kind: "content" });
  NodeAssert.deepEqual(plan({ status: "DU" }), { action: "take-upstream", kind: "content" });
});

test("add/add is added-broken only when our file no longer compiles", () => {
  NodeAssert.deepEqual(plan({ status: "AA", broken: true }), {
    action: "remove-added",
    kind: "added-broken",
  });
  NodeAssert.deepEqual(plan({ status: "AA", broken: false }), {
    action: "take-upstream",
    kind: "content",
  });
});

test("the nine seam files stay unmerged in a dry run and take upstream with --apply", () => {
  NodeAssert.equal(SEAM_FILES.length, 9);
  NodeAssert.ok(SEAM_FILES.includes("apps/server/src/auth/RpcAuthorization.ts"));
  NodeAssert.ok(SEAM_FILES.includes("apps/server/src/mcp/McpHttpServer.ts"));
  NodeAssert.ok(SEAM_FILES.includes("apps/server/src/mcp/McpInvocationContext.ts"));
  const seam = "apps/server/src/server.ts";
  NodeAssert.deepEqual(plan({ status: "UU", path: seam, seam: true }), {
    action: "leave-seam",
    kind: null,
  });
  NodeAssert.deepEqual(plan({ status: "UU", path: seam, seam: true, apply: true }), {
    action: "take-upstream",
    kind: null,
  });
});

test("an unknown conflict is reported, never guessed", () => {
  NodeAssert.deepEqual(plan({ status: "XY" }), { action: "unclassified", kind: null });
});

test("our added lines count without the file header", () => {
  const patch = [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    "@@ -1 +1,2 @@",
    "-old",
    "+new",
    "+more",
  ].join("\n");
  NodeAssert.equal(countPatchLines(patch), 2);
});

test("same content under orchestration-v2 is a relocation", () => {
  const ours = new Map([
    ["apps/server/src/orchestration/A.ts", "h1"],
    ["apps/server/src/orchestration/Other.ts", "h3"],
  ]);
  const result = new Map([
    ["apps/server/src/orchestration-v2/A.ts", "h1"],
    ["apps/server/src/orchestration-v2/B.ts", "h2"],
  ]);
  NodeAssert.deepEqual(renamedIntoV2(ours, result), ["apps/server/src/orchestration-v2/A.ts"]);
  NodeAssert.deepEqual(
    renamedIntoV2(ours, new Map(result).set("apps/server/src/orchestration-v2/A.ts", "h9")),
    [],
  );
});

test("an import that existed at ours and is gone after the merge is broken", () => {
  const file = "apps/server/src/personal/a.ts";
  const source = 'import { engine } from "../orchestration/Services/OrchestrationEngine.ts";';
  NodeAssert.equal(
    hasBrokenImport({
      file,
      source,
      oursFiles: new Set([file, "apps/server/src/orchestration/Services/OrchestrationEngine.ts"]),
      files: new Set([file]),
    }),
    true,
  );
  NodeAssert.equal(
    hasBrokenImport({
      file,
      source,
      oursFiles: new Set([file, "apps/server/src/orchestration/Services/OrchestrationEngine.ts"]),
      files: new Set([file, "apps/server/src/orchestration/Services/OrchestrationEngine.ts"]),
    }),
    false,
  );
});

test("a missing asset that never resolved is not a broken import", () => {
  NodeAssert.equal(
    hasBrokenImport({
      file: "apps/server/src/personal/a.ts",
      source: 'import data from "./model-manifest.json" with { type: "json" };',
      oursFiles: new Set(["apps/server/src/personal/a.ts"]),
      files: new Set(["apps/server/src/personal/a.ts"]),
    }),
    false,
  );
});

test("target PR falls back to B1 for triage", () => {
  NodeAssert.equal(targetPrFor("apps/server/src/personal/a.ts"), "3a");
  NodeAssert.equal(targetPrFor("apps/server/src/orchestration-v2/a.ts"), "C1-C3");
  NodeAssert.equal(targetPrFor("apps/web/src/a.tsx"), "phase 4");
  NodeAssert.equal(targetPrFor("docs/readme.md"), "B1");
});

test("the DeepSeek area is tested before the generic provider area", () => {
  NodeAssert.equal(targetPrFor("packages/provider-deepseek/src/x.ts"), "D1-D7");
  NodeAssert.equal(targetPrFor("packages/provider-pi/src/x.ts"), "C5-C9");
});

const registry = () =>
  parseRegistryText(
    [
      "path\ttarget\tstatusAfterB1\trule\tflag\treason",
      "apps/server/src/provider/Services/ProviderCommandReactor.ts\tC4+C10\topen\tregistry\tpersona\tone call",
      "apps/server/src/provider/deepseek/adapter.ts\tD1\tdropped\tregistry\t\tupstreamed",
      "apps/server/src/provider/noop.ts\tB1\tdone\tunion\t\tkeep both key sets",
    ].join("\n"),
  );

test("the registry parses and rejects a duplicate path", () => {
  NodeAssert.equal(registry().size, 3);
  NodeAssert.throws(() =>
    parseRegistryText(
      [
        "path\ttarget\tstatusAfterB1\trule\tflag\treason",
        "a\tB1\tdone\tunion\t\tx",
        "a\tB1\tdone\tunion\t\tx",
      ].join("\n"),
    ),
  );
});

test("rule 1: a backport is every subject with an upstream PR number", () => {
  const upstream = new Set(["fix(cloud): keep a token (#25301)"]);
  NodeAssert.equal(backportMatches(["fix(cloud): keep a token (#25301)"], upstream), true);
  NodeAssert.equal(backportMatches([], upstream), false);
  NodeAssert.equal(backportMatches(["local fix"], upstream), false);
  NodeAssert.equal(
    backportMatches(["fix(cloud): keep a token (#25301)", "local"], upstream),
    false,
  );
});

test("rule 2: the registry wins before any area rule", () => {
  const assignment = targetFor({
    path: "apps/server/src/provider/deepseek/adapter.ts",
    patch: null,
    registry: registry(),
    backport: false,
  });
  NodeAssert.deepEqual(assignment, {
    target: "D1",
    status: "dropped",
    rule: "registry",
    flag: "",
    reason: "upstreamed",
  });
});

test("rule 3: a test whose added lines only stub v1 services is dropped", () => {
  const patch = [
    "--- a/x.test.ts",
    "+++ b/x.test.ts",
    "@@ -1 +1,4 @@",
    "+  const repo = Layer.provideMerge(ProjectionThreadMessageRepository);",
    "+  // v1 service stand-in",
    "+  getPendingInputActivities: () => Effect.void,",
    "+});",
  ].join("\n");
  NodeAssert.equal(isV1StubPatch({ path: "apps/server/src/x.test.ts", patch }), true);
  NodeAssert.equal(isV1StubPatch({ path: "apps/server/src/x.ts", patch }), false);
  NodeAssert.equal(
    isV1StubPatch({
      path: "apps/server/src/x.test.ts",
      patch: ["+  expect(turn).toEqual({ status: 'running' });"].join("\n"),
    }),
    false,
  );
});

test("rule 4: a test takes the target of the source it names", () => {
  const entries = parseRegistryText(
    [
      "path\ttarget\tstatusAfterB1\trule\tflag\treason",
      "apps/server/src/orchestration/decider.ts\tC1\topen\tregistry\t\tdeleted guard",
      "apps/server/src/usage/usageScanCache.ts\tC14\topen\tregistry\t\treset window",
    ].join("\n"),
  );
  NodeAssert.equal(
    followSourceTarget("apps/server/src/orchestration/decider.delete.test.ts", entries)?.target,
    "C1",
  );
  NodeAssert.equal(
    followSourceTarget("apps/server/test/usageScanCache.test.ts", entries)?.target,
    "C14",
  );
});

test("rule 5: an unregistered path falls to its area", () => {
  const assignment = targetFor({
    path: "apps/server/src/provider/other.ts",
    patch: null,
    registry: new Map(),
    backport: false,
  });
  NodeAssert.deepEqual(assignment, {
    target: "C5-C9",
    status: "open",
    rule: "area",
    flag: "",
    reason: "area C5-C9",
  });
});

test("rule 6: no match is null, never B1 open", () => {
  NodeAssert.equal(
    targetFor({ path: "docs/readme.md", patch: null, registry: new Map(), backport: false }),
    null,
  );
});

test("the superseded table parses and rejects a bad sha or a duplicate", () => {
  const header = "sha\tsubject\tproof";
  const sha = "4cabfdaab717b245dbc5908f35f497b46fa5c5b3";
  NodeAssert.deepEqual(parseSupersededText([header, `${sha}\tplatform\tU pins it`].join("\n")), [
    { sha, subject: "platform", proof: "U pins it" },
  ]);
  NodeAssert.throws(
    () => parseSupersededText([header, "short\tplatform\tproof"].join("\n")),
    /40 lowercase/,
  );
  NodeAssert.throws(
    () => parseSupersededText([header, `${sha}\ta\tb`, `${sha}\tc\td`].join("\n")),
    /duplicate sha/,
  );
});

test("the superseded predicate needs base and our blob to match the commit", () => {
  const commits = [
    {
      sha: "a".repeat(40),
      parentTree: new Map([
        ["p.ts", "base"],
        ["kept.ts", "base"],
      ]),
      tree: new Map([
        ["p.ts", "ours"],
        ["kept.ts", "ours"],
      ]),
    },
  ];
  const baseTree = new Map([
    ["p.ts", "base"],
    ["kept.ts", "base"],
    ["added.ts", undefined],
  ]);
  const oursTree = new Map([
    ["p.ts", "ours"],
    ["kept.ts", "other"],
    ["added.ts", "new"],
  ]);
  NodeAssert.equal(supersededBy({ origin: "p.ts", baseTree, oursTree, commits }), "a".repeat(40));
  NodeAssert.equal(supersededBy({ origin: "kept.ts", baseTree, oursTree, commits }), null);
  NodeAssert.equal(supersededBy({ origin: "added.ts", baseTree, oursTree, commits }), null);
});

test("the superseded rule runs before the registry", () => {
  const assignment = targetFor({
    path: "apps/web/src/a.ts",
    patch: null,
    registry: parseRegistryText(
      [
        "path\ttarget\tstatusAfterB1\trule\tflag\treason",
        "apps/web/src/a.ts\tphase 4\topen\tregistry\t\tweb",
      ].join("\n"),
    ),
    backport: false,
    superseded: "b".repeat(40),
  });
  NodeAssert.equal(assignment.target, "B1");
  NodeAssert.equal(assignment.status, "dropped");
  NodeAssert.equal(assignment.rule, "superseded");
});

test("stages parse from git ls-files -u -z output", () => {
  const text = [
    "100644 aaaa 1\tapps/server/src/x.ts",
    "100644 bbbb 2\tapps/server/src/x.ts",
    "100644 cccc 3\tapps/server/src/x.ts",
  ].join("\0");
  const stages = parseUnmergedStages(`${text}\0`);
  NodeAssert.equal(stages.get(1), "aaaa");
  NodeAssert.equal(stages.get(2), "bbbb");
  NodeAssert.equal(stages.get(3), "cccc");
});

test("a rename origin must be the only path with the stage blobs", () => {
  const path = "d/X.ts";
  const stages = new Map([
    [1, "base"],
    [2, "ours"],
  ]);
  const baseTree = new Map([
    ["d/Layers/X.ts", "base"],
    ["d/Layers/Y.ts", "other"],
  ]);
  const upstreamTree = new Map([["d/X.ts", "theirs"]]);
  const oursTree = new Map([
    ["d/Layers/X.ts", "ours"],
    ["d/Layers/Y.ts", "y"],
  ]);
  NodeAssert.deepEqual(originFor({ path, stages, oursTree, upstreamTree, baseTree }), {
    ok: true,
    origin: "d/Layers/X.ts",
    candidates: ["d/Layers/X.ts"],
  });
  const several = originFor({
    path,
    stages,
    baseTree: new Map([
      ["d/Layers/X.ts", "base"],
      ["d/Layers/Z.ts", "base"],
    ]),
    upstreamTree,
    oursTree: new Map([
      ["d/Layers/X.ts", "ours"],
      ["d/Layers/Z.ts", "ours"],
    ]),
  });
  NodeAssert.equal(several.ok, false);
  NodeAssert.deepEqual(several.candidates, ["d/Layers/X.ts", "d/Layers/Z.ts"]);
  const none = originFor({
    path,
    stages,
    baseTree: new Map([["d/Layers/X.ts", "base"]]),
    upstreamTree,
    oursTree: new Map([["d/Layers/X.ts", "different"]]),
  });
  NodeAssert.equal(none.ok, false);
  NodeAssert.deepEqual(none.candidates, []);
});

test("a patch with no hunk is empty", () => {
  NodeAssert.equal(hasHunks(""), false);
  NodeAssert.equal(hasHunks("diff --git a/x b/x\nBinary files a/x and b/x differ\n"), false);
  NodeAssert.equal(hasHunks("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n"), true);
});

test("the assignments group is the path group, not the rule", () => {
  NodeAssert.equal(groupFor("apps/server/src/provider/x.ts"), "apps/server/src/provider");
  NodeAssert.equal(groupFor("packages/client-runtime/src/a.ts"), "packages/client-runtime");
  NodeAssert.equal(groupFor("apps/server/src/root.ts"), "apps/server/src (root)");
});

const RESOLVER = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "v2-merge-resolve.mjs",
);

const fixtureGit = (repo, args) =>
  NodeChildProcess.execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const fixtureWrite = (repo, path, content) => {
  const target = NodePath.join(repo, path);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, content);
};

const fixtureCommit = (repo, message) => {
  fixtureGit(repo, ["add", "-A"]);
  fixtureGit(repo, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-q",
    "-m",
    message,
  ]);
  return fixtureGit(repo, ["rev-parse", "HEAD"]).trim();
};

const makeFixture = () => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v2-merge-repo-"));
  const meta = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v2-merge-meta-"));
  fixtureGit(repo, ["init", "-q"]);
  fixtureGit(repo, ["checkout", "-q", "-b", "ours"]);
  NodeFS.writeFileSync(
    NodePath.join(meta, "registry.tsv"),
    "path\ttarget\tstatusAfterB1\trule\tflag\treason\n",
  );
  NodeFS.writeFileSync(NodePath.join(meta, "superseded.tsv"), "sha\tsubject\tproof\n");
  return { repo, meta };
};

const runResolver = ({ repo, meta }) => {
  try {
    const stdout = NodeChildProcess.execFileSync(
      process.execPath,
      [
        RESOLVER,
        "--repo",
        repo,
        "--ours",
        "ours",
        "--theirs",
        "theirs",
        "--ledger",
        NodePath.join(repo, "ledger"),
        "--registry",
        NodePath.join(meta, "registry.tsv"),
        "--superseded",
        NodePath.join(meta, "superseded.tsv"),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? error.message),
    };
  }
};

const readLedger = (repo) => {
  const text = NodeFS.readFileSync(NodePath.join(repo, "ledger", "ledger.tsv"), "utf8");
  const [header, ...lines] = text.trimEnd().split("\n");
  const columns = header.split("\t");
  return lines
    .filter((line) => line.length > 0)
    .map((line) =>
      Object.fromEntries(line.split("\t").map((value, index) => [columns[index], value])),
    );
};

const readPatch = (repo, path) =>
  NodeFS.readFileSync(NodePath.join(repo, "ledger", "patches", `${path}.patch`), "utf8");

const cleanup = (fixture) => {
  NodeFS.rmSync(fixture.repo, { recursive: true, force: true });
  NodeFS.rmSync(fixture.meta, { recursive: true, force: true });
};

test("fixture A: an upstream rename parks our change at its origin path", () => {
  const fixture = makeFixture();
  const { repo } = fixture;
  const basePath = "apps/server/src/provider/Layers/X.ts";
  const renamedPath = "apps/server/src/provider/X.ts";
  const baseContent = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
  try {
    fixtureWrite(repo, basePath, baseContent);
    const base = fixtureCommit(repo, "base");
    fixtureWrite(repo, basePath, baseContent.replace("line 2\n", "line 2 ours\n"));
    fixtureCommit(repo, "edit our side");
    fixtureGit(repo, ["checkout", "-q", "-b", "theirs", base]);
    fixtureGit(repo, ["mv", basePath, renamedPath]);
    fixtureWrite(repo, renamedPath, baseContent.replace("line 2\n", "line 2 upstream\n"));
    fixtureCommit(repo, "rename upstream");
    fixtureGit(repo, ["checkout", "-q", "ours"]);

    const result = runResolver(fixture);
    NodeAssert.equal(result.status, 0, result.stderr);
    const row = readLedger(repo).find((candidate) => candidate.path === renamedPath);
    NodeAssert.ok(row, result.stdout);
    NodeAssert.equal(row.origin, basePath);
    NodeAssert.equal(row.kind, "content");
    NodeAssert.equal(row.targetPR, "C5-C9");
    NodeAssert.equal(row.status, "open");
    NodeAssert.ok(Number(row.ourLines) > 0);
    NodeAssert.match(readPatch(repo, renamedPath), /^@@/m);
  } finally {
    cleanup(fixture);
  }
});

test("fixture B: two matching origins fail the run", () => {
  const fixture = makeFixture();
  const { repo } = fixture;
  const basePath = "apps/server/src/provider/Layers/X.ts";
  const secondPath = "apps/server/src/provider/Layers/X2.ts";
  const renamedPath = "apps/server/src/provider/X.ts";
  const baseContent = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
  const oursContent = baseContent.replace("line 2\n", "line 2 ours\n");
  try {
    fixtureWrite(repo, basePath, baseContent);
    fixtureWrite(repo, secondPath, baseContent);
    const base = fixtureCommit(repo, "base");
    fixtureWrite(repo, basePath, oursContent);
    fixtureWrite(repo, secondPath, oursContent);
    fixtureCommit(repo, "edit both");
    fixtureGit(repo, ["checkout", "-q", "-b", "theirs", base]);
    fixtureGit(repo, ["mv", basePath, renamedPath]);
    fixtureWrite(repo, renamedPath, baseContent.replace("line 2\n", "line 2 upstream\n"));
    fixtureGit(repo, ["rm", "-q", secondPath]);
    fixtureCommit(repo, "rename one and delete the twin");
    fixtureGit(repo, ["checkout", "-q", "ours"]);

    const result = runResolver(fixture);
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stderr, /rename origin is not unique/);
    NodeAssert.match(result.stdout, /candidates=2/);
    NodeAssert.match(result.stdout, /Layers\/X\.ts/);
    NodeAssert.match(result.stdout, /Layers\/X2\.ts/);
  } finally {
    cleanup(fixture);
  }
});

test("fixture C: the superseded commit is dropped and its added file is not", () => {
  const fixture = makeFixture();
  const { repo, meta } = fixture;
  const sourcePath = "apps/server/src/provider/Layers/C.ts";
  const addedPath = "apps/server/src/personal/added.ts";
  try {
    fixtureWrite(repo, sourcePath, "base\n");
    const base = fixtureCommit(repo, "base");
    fixtureWrite(repo, sourcePath, "ours\n");
    fixtureWrite(repo, addedPath, "export const added = 1;\n");
    const superseded = fixtureCommit(repo, "chore(platform): move the port");
    fixtureGit(repo, ["checkout", "-q", "-b", "theirs", base]);
    fixtureWrite(repo, sourcePath, "upstream\n");
    fixtureWrite(repo, addedPath, "export const added = 2;\n");
    fixtureCommit(repo, "upstream work");
    fixtureGit(repo, ["checkout", "-q", "ours"]);
    NodeFS.writeFileSync(
      NodePath.join(meta, "superseded.tsv"),
      `sha\tsubject\tproof\n${superseded}\tchore(platform): move the port\tU carries it\n`,
    );

    const result = runResolver(fixture);
    NodeAssert.equal(result.status, 0, result.stderr);
    const rows = readLedger(repo);
    const dropped = rows.find((row) => row.path === sourcePath);
    NodeAssert.ok(dropped, result.stdout);
    NodeAssert.equal(dropped.targetPR, "B1");
    NodeAssert.equal(dropped.status, "dropped");
    const added = rows.find((row) => row.path === addedPath);
    NodeAssert.ok(added, result.stdout);
    NodeAssert.equal(added.targetPR, "3a");
    NodeAssert.equal(added.status, "open");
  } finally {
    cleanup(fixture);
  }
});

test("fixture D: a content row with no hunk fails the run", () => {
  const fixture = makeFixture();
  const { repo } = fixture;
  const path = "apps/server/src/provider/Layers/D.bin";
  try {
    fixtureWrite(repo, path, Buffer.from([0, 1, 2, 3]));
    const base = fixtureCommit(repo, "base");
    fixtureWrite(repo, path, Buffer.from([9, 1, 2, 3]));
    fixtureCommit(repo, "change the first byte");
    fixtureGit(repo, ["checkout", "-q", "-b", "theirs", base]);
    fixtureWrite(repo, path, Buffer.from([0, 9, 2, 3]));
    fixtureCommit(repo, "change the second byte");
    fixtureGit(repo, ["checkout", "-q", "ours"]);

    const result = runResolver(fixture);
    NodeAssert.equal(result.status, 1);
    NodeAssert.match(result.stderr, /empty patch/);
    NodeAssert.match(result.stderr, /D\.bin/);
  } finally {
    cleanup(fixture);
  }
});
