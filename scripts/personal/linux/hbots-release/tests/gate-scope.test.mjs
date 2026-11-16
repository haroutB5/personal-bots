// The gate-scope registry, the per-check planner and the seal's plan check. Run with node --test.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { CHECKS, classifyPath, commandsFor, planChecks } from "../lib/gateScope.mjs";
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

const CORE = [
  "bots-list-chat",
  "new-chat-named",
  "delegate-task",
  "chats-search",
  "long-press-reply",
  "continue-chat",
  "revoked-session",
];

// The evidence a push-service change must carry: server-tests selected, server-tsc
// whole, e2e with the core journeys. `omit` drops a gate, `patch` edits one.
const selectedEvidence = ({ base, paths, args, omit = [], patch = {} }) => {
  const common = { baseSha: base, changedPaths: paths, reason: "inputs changed" };
  const gates = [
    {
      id: "server-tests",
      kind: "vitest",
      mode: "selected",
      selector: "serverTests@1",
      ...common,
      args,
    },
    {
      id: "server-tsc",
      kind: "tsc",
      mode: "whole",
      ...common,
    },
    {
      id: "e2e",
      kind: "e2e",
      mode: "selected",
      selector: "e2eJourneys@1",
      ...common,
      args: CORE,
      journeys: CORE.map((id) => ({ id, ok: true })),
    },
  ]
    .filter((gate) => !omit.includes(gate.id))
    .map((gate) => ({ ...gate, ...patch[gate.id] }));
  return { gates };
};

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

const pushCase = (body) =>
  withFixture((f) => {
    const cfg = { currentTxt: NodePath.join(f.releases, "current.txt") };
    const paths = ["apps/server/src/personal/push/PersonalPushService.ts"];
    const a = { "repo-root": f.repo, release: f.head };
    const args = ["src/personal/push/PersonalPushService.test.ts"];
    body({
      f,
      cfg,
      a,
      args,
      evidence: (extra = {}) => selectedEvidence({ base: f.base, paths, args, ...extra }),
    });
  });

NodeTest.test("the seal accepts the full evidence for a push-service change", () => {
  pushCase(({ cfg, a, evidence }) =>
    NodeAssert.deepEqual(planEvidenceProblems(cfg, a, evidence()), []),
  );
});

NodeTest.test("the seal refuses evidence that leaves out a planned gate", () => {
  pushCase(({ cfg, a, evidence }) => {
    NodeAssert.match(
      planEvidenceProblems(cfg, a, evidence({ omit: ["server-tsc"] })).join(" "),
      /server-tsc is planned whole but missing/,
    );
    NodeAssert.match(
      planEvidenceProblems(cfg, a, evidence({ omit: ["server-tests"] })).join(" "),
      /server-tests is planned selected but missing/,
    );
  });
});

NodeTest.test("the seal refuses a skip claimed for a gate the plan runs", () => {
  pushCase(({ cfg, a, evidence }) => {
    const forged = evidence({
      patch: { "server-tests": { mode: "skip", args: undefined, selector: undefined } },
    });
    NodeAssert.match(
      planEvidenceProblems(cfg, a, forged).join(" "),
      /server-tests is skip, the recomputed plan is selected/,
    );
  });
});

NodeTest.test("the seal refuses e2e journeys that differ from the planned ones", () => {
  pushCase(({ cfg, a, evidence }) => {
    const few = CORE.slice(0, 5);
    const forged = evidence({
      patch: { e2e: { journeys: few.map((id) => ({ id, ok: true })) } },
    });
    NodeAssert.match(
      planEvidenceProblems(cfg, a, forged).join(" "),
      /e2e journeys differ from the planned journeys/,
    );
  });
});

NodeTest.test("the seal refuses a whole gate whose recorded args differ", () => {
  withFixture((f) => {
    const cfg = { currentTxt: NodePath.join(f.releases, "current.txt") };
    fixtureToolchainEdit(f);
    const a = { "repo-root": f.repo, release: f.head2 };
    const reader = gitReader(f.repo, f.head2);
    const paths = git(f.repo, "diff", "--no-renames", "--name-only", f.base, f.head2)
      .split("\n")
      .filter(Boolean);
    const scope = planChecks(paths, { reader });
    const gates = scope.plans.map((plan) => ({
      id: plan.id,
      mode: "whole",
      reason: "toolchain",
      baseSha: f.base,
      changedPaths: paths,
      ...(plan.args ? { args: plan.args } : {}),
    }));
    NodeAssert.deepEqual(planEvidenceProblems(cfg, a, { gates }), []);
    const forged = gates.map((gate) =>
      gate.id === "server-tests" ? { ...gate, args: ["src/personal"] } : gate,
    );
    NodeAssert.match(
      planEvidenceProblems(cfg, a, { gates: forged }).join(" "),
      /server-tests args differ from the recomputed plan/,
    );
  });
});

function fixtureToolchainEdit(f) {
  NodeFS.writeFileSync(NodePath.join(f.repo, "package.json"), '{"name":"x"}\n');
  f.head2 = commit(f.repo, "toolchain");
  git(f.repo, "reset", "-q", "--hard", f.head2);
}

const CLI = NodePath.join(ROOT, "lib/gateScope.mjs");
const cli = (repo, ...args) =>
  NodeChildProcess.spawnSync(process.execPath, [CLI, "--repo", repo, ...args], {
    encoding: "utf8",
  });

NodeTest.test(
  "the builder command plans from the merge base and uses this checkout's gate commands",
  () => {
    withFixture((f) => {
      // trunk moves on after the branch point: a change the branch never made.
      git(f.repo, "branch", "feature", f.head);
      git(f.repo, "checkout", "-q", "-b", "trunk", f.base);
      NodeFS.mkdirSync(NodePath.join(f.repo, "apps/web"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(f.repo, "apps/web/other.ts"), "export const other = 1;\n");
      commit(f.repo, "trunk moves on");
      const json = cli(f.repo, "--base", "trunk", "--head", "feature", "--json");
      NodeAssert.equal(json.status, 0, json.stderr);
      const result = JSON.parse(json.stdout);
      NodeAssert.deepEqual(result.changedPaths, [
        "apps/server/src/personal/push/PersonalPushService.ts",
      ]);
      NodeAssert.equal(result.baseSha, f.base);
      const lines = cli(f.repo, "--base", "trunk", "--head", "feature", "--commands");
      NodeAssert.equal(lines.status, 0, lines.stderr);
      NodeAssert.match(
        lines.stdout,
        /vp test run src\/personal\/push\/PersonalPushService\.test\.ts/,
      );
      NodeAssert.doesNotMatch(lines.stdout, /e2e-smoke/);
    });
  },
);

// Files a lane would run: every .test.ts token of its command, after the --shard
// flag is applied the way vitest applies it (round robin over the file list).
const lanesRun = (lanes) =>
  lanes.map((lane) => {
    const command = lane[0];
    const files = command.split(/\s+/).filter((token) => token.endsWith(".test.ts"));
    const shard = /--shard=(\d+)\/(\d+)/.exec(command);
    if (!shard) return files;
    const [index, count] = [Number(shard[1]), Number(shard[2])];
    return files.filter((_, at) => at % count === index - 1);
  });

NodeTest.test("a selected server set over 150 files runs every file in some lane", () => {
  const defs = JSON.parse(NodeFS.readFileSync(GATES_JSON, "utf8"));
  const def = defs.find((entry) => entry.id === "server-tests");
  const args = Array.from({ length: 389 }, (_, i) => `src/personal/gen/file${i}.test.ts`);
  const lanes = commandsFor({ id: "server-tests", mode: "selected", args }, def);
  NodeAssert.equal(lanes.length, 2);
  const ran = new Set(lanesRun(lanes).flat());
  for (const file of args) NodeAssert.ok(ran.has(file), `${file} never runs`);
  NodeAssert.ok(!lanes.flat().some((command) => command.includes("--shard")));
  const small = commandsFor(
    { id: "server-tests", mode: "selected", args: args.slice(0, 100) },
    def,
  );
  NodeAssert.equal(small.length, 1);
  NodeAssert.equal(new Set(lanesRun(small).flat()).size >= 100, true);
});
