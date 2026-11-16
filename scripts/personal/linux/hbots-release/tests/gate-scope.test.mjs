// The gate-scope registry, the per-check planner and the seal's plan check. Run with node --test.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { CHECKS, classifyPath, planChecks } from "../lib/gateScope.mjs";
import { fsReader, gitReader } from "../lib/serverTestSelect.mjs";
import { planEvidenceProblems } from "../lib/seal.mjs";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const REPO = NodePath.resolve(ROOT, "../../../..");
const SCRATCH = NodePath.join(REPO, ".tmp");
NodeFS.mkdirSync(SCRATCH, { recursive: true });
const GATES_JSON = NodePath.join(REPO, "scripts/personal/node/gates-linux.json");

const git = (repo, ...args) => {
  const result = NodeChildProcess.spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  NodeAssert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const running = (scope) =>
  scope.plans.filter((plan) => plan.mode !== "skip").map((plan) => plan.id);
const planOf = (scope, id) => scope.plans.find((plan) => plan.id === id);

const commit = (repo, message) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

function fixture() {
  const dir = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "gate-scope-"));
  const repo = NodePath.join(dir, "repo");
  const releases = NodePath.join(dir, "releases");
  const lib = NodePath.join(repo, "scripts/personal/linux/hbots-release/lib");
  NodeFS.mkdirSync(NodePath.join(repo, "apps/server/src/personal/push"), { recursive: true });
  NodeFS.mkdirSync(lib, { recursive: true });
  NodeFS.mkdirSync(releases, { recursive: true });
  for (const file of ["gateScope.mjs", "serverTestSelect.mjs"])
    NodeFS.copyFileSync(NodePath.join(ROOT, "lib", file), NodePath.join(lib, file));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  NodeFS.writeFileSync(
    NodePath.join(repo, "apps/server/src/personal/push/PersonalPushService.ts"),
    "export const push = 1;\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(repo, "apps/server/src/personal/push/PersonalPushService.test.ts"),
    'import * as Push from "./PersonalPushService.ts";\nPush.push;\n',
  );
  const base = commit(repo, "baseline");
  NodeFS.writeFileSync(
    NodePath.join(repo, "apps/server/src/personal/push/PersonalPushService.ts"),
    "export const push = 2;\n",
  );
  const head = commit(repo, "push change");
  NodeFS.writeFileSync(NodePath.join(releases, "current.txt"), `${base}\n`);
  return { dir, repo, releases, base, head };
}

const withFixture = (body) => {
  const f = fixture();
  try {
    body(f);
  } finally {
    NodeFS.rmSync(f.dir, { recursive: true, force: true });
  }
};

const selectedEvidence = ({ base, paths, args }) => ({
  gates: [
    {
      id: "server-tests",
      kind: "vitest",
      mode: "selected",
      selector: "serverTests@1",
      reason: "server-tests inputs changed",
      baseSha: base,
      changedPaths: paths,
      args,
    },
  ],
});

NodeTest.test("every tracked path classifies", () => {
  const paths = git(REPO, "ls-files", "-z").split("\0").filter(Boolean);
  const unmapped = paths.filter((file) => classifyPath(file).kind === "unmapped");
  NodeAssert.deepEqual(unmapped, []);
  const gateIds = JSON.parse(NodeFS.readFileSync(GATES_JSON, "utf8")).map((gate) => gate.id);
  for (const id of Object.keys(CHECKS)) NodeAssert.ok(gateIds.includes(id), id);
});

NodeTest.test("the 1.67.20 replay selects 21 server tests", () => {
  const base = "d8a0c8f571267663ea5995d82240699ee6e557d9";
  const head = "a72547da6f6c7ecf7e1ee6a07aa68ac5430370aa";
  const paths = git(REPO, "diff", "--no-renames", "--name-only", base, head)
    .split("\n")
    .filter(Boolean);
  // The plan for an old diff is replayed against the current tree, the way a
  // dry run plans a new release from the checkout that holds it.
  const scope = planChecks(paths, { reader: gitReader(REPO, git(REPO, "rev-parse", "HEAD")) });
  const plan = planOf(scope, "server-tests");
  NodeAssert.equal(plan.mode, "selected");
  NodeAssert.equal(plan.args.length, 21);
  NodeAssert.ok(plan.args.includes("src/personal/push/PersonalPushService.test.ts"));
  NodeAssert.ok(!plan.args.includes("src/persistence/sqliteCheckpointWorker.test.ts"));
});

NodeTest.test("a version-bump-only diff runs only hbots-mobile", () => {
  const scope = planChecks(["scripts/personal/app-version.txt", "apps/hbots-mobile/package.json"], {
    reader: fsReader(REPO),
  });
  NodeAssert.deepEqual(running(scope), ["hbots-mobile"]);
  NodeAssert.equal(planOf(scope, "hbots-mobile").mode, "whole");
});

NodeTest.test("a release-tools diff runs only release-tools", () => {
  const scope = planChecks(["scripts/personal/linux/hbots-release/lib/gateScope.mjs"], {
    reader: fsReader(REPO),
  });
  NodeAssert.deepEqual(running(scope), ["release-tools"]);
  const plan = planOf(scope, "release-tools");
  NodeAssert.equal(plan.mode, "selected");
  NodeAssert.ok(
    plan.args.includes("scripts/personal/linux/hbots-release/tests/gate-scope.test.mjs"),
  );
});

NodeTest.test("a literal path change selects its reader test", () => {
  const scope = planChecks(["apps/server/scripts/acp-mock-agent.ts"], {
    reader: fsReader(REPO),
  });
  const plan = planOf(scope, "server-tests");
  NodeAssert.equal(plan.mode, "selected");
  NodeAssert.ok(plan.args.includes("src/provider/acp/AcpJsonRpcConnection.test.ts"));
});

NodeTest.test("a Kotlin module change selects that module and its dependents", () => {
  const scope = planChecks(
    [
      "apps/hbots-mobile/modules/hbots-updater/android/src/main/java/expo/modules/hbotsupdater/UpdateWorker.kt",
    ],
    { reader: fsReader(REPO) },
  );
  const plan = planOf(scope, "hbots-mobile-kotlin");
  NodeAssert.equal(plan.mode, "selected");
  NodeAssert.deepEqual([...plan.args].sort(), [
    ":hbots-notify:testDebugUnitTest",
    ":hbots-updater:testDebugUnitTest",
  ]);
  const whole = planOf(
    planChecks(["package.json"], { reader: fsReader(REPO) }),
    "hbots-mobile-kotlin",
  );
  NodeAssert.equal(whole.mode, "whole");
  NodeAssert.ok(whole.args.includes(":hbots-camera:testDebugUnitTest"));
  NodeAssert.ok(whole.args.includes(":hbots-pageview:testDebugUnitTest"));
});

NodeTest.test("an unmapped path stops the plan", () => {
  const scope = planChecks(["brand-new-area/file.ts"], { reader: fsReader(REPO) });
  NodeAssert.equal(scope.error, "unmapped");
  NodeAssert.deepEqual(scope.paths, ["brand-new-area/file.ts"]);
});

NodeTest.test("the seal refuses evidence whose args differ from the recomputed plan", () => {
  withFixture((f) => {
    const cfg = { currentTxt: NodePath.join(f.releases, "current.txt") };
    const paths = ["apps/server/src/personal/push/PersonalPushService.ts"];
    const a = { "repo-root": f.repo, release: f.head };
    const good = selectedEvidence({
      base: f.base,
      paths,
      args: ["src/personal/push/PersonalPushService.test.ts"],
    });
    NodeAssert.deepEqual(planEvidenceProblems(cfg, a, good), []);
    const wrong = selectedEvidence({
      base: f.base,
      paths,
      args: ["src/persistence/other.test.ts"],
    });
    NodeAssert.match(
      planEvidenceProblems(cfg, a, wrong).join(" "),
      /args differ from the recomputed plan/,
    );
  });
});

NodeTest.test("the seal refuses a selected gate whose base is not live", () => {
  withFixture((f) => {
    const cfg = { currentTxt: NodePath.join(f.releases, "current.txt") };
    const paths = ["apps/server/src/personal/push/PersonalPushService.ts"];
    const evidence = selectedEvidence({
      base: "f".repeat(40),
      paths,
      args: ["src/personal/push/PersonalPushService.test.ts"],
    });
    const problems = planEvidenceProblems(cfg, { "repo-root": f.repo, release: f.head }, evidence);
    NodeAssert.match(problems.join(" "), /claims base .* live is/);
  });
});

NodeTest.test("release tooling beside scripts/personal maps to release-tools", () => {
  for (const file of [
    "scripts/personal/sqlite-check.cjs",
    "scripts/personal/sqlite-snapshot.cjs",
    "scripts/personal/idle-classification-16654.mjs",
    "scripts/personal/copy-externals.mjs",
    "scripts/personal/migration-check.cjs",
  ]) {
    NodeAssert.deepEqual(classifyPath(file).checks, ["release-tools"], file);
  }
});

NodeTest.test("a new folder under scripts/personal is unmapped, upstream scripts are not", () => {
  NodeAssert.equal(classifyPath("scripts/personal/brand-new/run.mjs").kind, "unmapped");
  NodeAssert.equal(classifyPath("scripts/personal/brand-new.mjs").kind, "unmapped");
  NodeAssert.equal(classifyPath("scripts/test-cached.ts").kind, "none");
  NodeAssert.equal(classifyPath("scripts/scenarios/t3.ts").kind, "none");
  NodeAssert.equal(classifyPath("scripts/personal/backup.ps1").kind, "none");
  NodeAssert.equal(classifyPath("scripts/personal/perf/skill/x.md").kind, "none");
});
