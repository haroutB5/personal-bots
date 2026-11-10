// The gate-scope allowlist and the seal's skip check. Run with node --test.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { classifyGateScope, verifySkippedGates } from "../lib/gateScope.mjs";
import { skipEvidenceProblems } from "../lib/seal.mjs";
import { gateScopeOf } from "../../dev-team-tools/gate-common.mjs";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const SCRATCH = NodePath.join(ROOT, "../../../..", ".tmp");
NodeFS.mkdirSync(SCRATCH, { recursive: true });

const git = (repo, ...args) => {
  const result = NodeChildProcess.spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  NodeAssert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

const commit = (repo, message) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

function fixture() {
  const dir = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "gate-scope-"));
  const repo = NodePath.join(dir, "repo");
  const releases = NodePath.join(dir, "releases");
  NodeFS.mkdirSync(NodePath.join(repo, "apps/server/src"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(repo, "apps/hbots-mobile"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(repo, "scripts/personal/linux/hbots-release/lib"), {
    recursive: true,
  });
  NodeFS.copyFileSync(
    NodePath.join(ROOT, "lib/gateScope.mjs"),
    NodePath.join(repo, "scripts/personal/linux/hbots-release/lib/gateScope.mjs"),
  );
  NodeFS.mkdirSync(releases, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  NodeFS.writeFileSync(
    NodePath.join(repo, "apps/server/src/index.ts"),
    "export const value = 1;\n",
  );
  const base = commit(repo, "baseline");
  NodeFS.writeFileSync(NodePath.join(repo, "apps/hbots-mobile/app.json"), '{"version": "1.0.0"}\n');
  const mobile = commit(repo, "mobile only");
  NodeFS.writeFileSync(
    NodePath.join(repo, "apps/server/src/index.ts"),
    "export const value = 2;\n",
  );
  const server = commit(repo, "server change");
  NodeFS.writeFileSync(NodePath.join(releases, "current.txt"), `${base}\n`);
  return { dir, repo, releases, base, mobile, server };
}

const skipEvidence = (baseSha, changedPaths, ids = ["server-tests", "e2e"]) => ({
  gates: ids.map((id) => ({
    id,
    kind: id === "e2e" ? "e2e" : "vitest",
    skipped: true,
    reason: "mobile/docs-only diff",
    baseSha,
    changedPaths,
  })),
});

const withFixture = (body) => {
  const f = fixture();
  try {
    body(f);
  } finally {
    NodeFS.rmSync(f.dir, { recursive: true, force: true });
  }
};

NodeTest.test("a mobile-only diff skips server-tests and e2e", () => {
  NodeAssert.deepEqual(classifyGateScope(["apps/hbots-mobile/app.json"]), {
    action: "skip",
    reason: "every changed path is under apps/hbots-mobile/, under docs/, or a markdown file",
    changedPaths: ["apps/hbots-mobile/app.json"],
  });
});

NodeTest.test("a docs-only diff skips", () => {
  NodeAssert.equal(classifyGateScope(["docs/releases/HANDOFF-1672.md"]).action, "skip");
});

NodeTest.test("markdown outside docs skips", () => {
  NodeAssert.equal(classifyGateScope(["README.md", "apps/server/README.md"]).action, "skip");
});

NodeTest.test("mobile plus packages/shared runs", () => {
  const scope = classifyGateScope([
    "apps/hbots-mobile/app.json",
    "packages/shared/src/testing/providerEnv.ts",
  ]);
  NodeAssert.equal(scope.action, "run");
  NodeAssert.match(scope.reason, /packages\/shared\/src\/testing\/providerEnv\.ts/);
});

NodeTest.test("scripts runs", () => {
  NodeAssert.equal(classifyGateScope(["scripts/personal/node/gates-linux.json"]).action, "run");
});

NodeTest.test("an empty diff runs", () => {
  NodeAssert.equal(classifyGateScope([]).action, "run");
});

NodeTest.test("an unsafe path runs", () => {
  NodeAssert.equal(
    classifyGateScope(["apps/hbots-mobile/../apps/server/src/index.ts"]).action,
    "run",
  );
});

NodeTest.test("the seal accepts a matching mobile-only skip", () => {
  withFixture((f) => {
    const paths = ["apps/hbots-mobile/app.json"];
    NodeAssert.deepEqual(
      verifySkippedGates({
        evidence: skipEvidence(f.base, paths),
        liveSha: f.base,
        releaseSha: f.mobile,
        changedPaths: paths,
      }),
      [],
    );
    const cfg = { currentTxt: NodePath.join(f.releases, "current.txt") };
    NodeAssert.deepEqual(
      skipEvidenceProblems(
        cfg,
        { "repo-root": f.repo, release: f.mobile },
        skipEvidence(f.base, paths),
      ),
      [],
    );
  });
});

NodeTest.test("the seal refuses a skip on a server-touching diff", () => {
  withFixture((f) => {
    const cfg = { currentTxt: NodePath.join(f.releases, "current.txt") };
    const evidence = skipEvidence(f.base, ["apps/hbots-mobile/app.json"]);
    const problems = skipEvidenceProblems(
      cfg,
      { "repo-root": f.repo, release: f.server },
      evidence,
    );
    NodeAssert.equal(problems.length > 0, true);
    NodeAssert.match(
      problems.join(" "),
      /must run: paths outside the mobile\/docs allowlist: apps\/server\/src\/index\.ts/,
    );
  });
});

NodeTest.test("the seal refuses a skip of a gate that must run", () => {
  withFixture((f) => {
    const paths = ["apps/hbots-mobile/app.json"];
    const problems = verifySkippedGates({
      evidence: skipEvidence(f.base, paths, ["web-tests"]),
      liveSha: f.base,
      releaseSha: f.mobile,
      changedPaths: paths,
    });
    NodeAssert.match(problems.join(" "), /gate web-tests may not be skipped/);
  });
});

NodeTest.test("an unknown base runs and cannot justify a skip", () => {
  withFixture((f) => {
    NodeFS.writeFileSync(NodePath.join(f.releases, "current.txt"), `${"f".repeat(40)}\n`);
    const v = { repo: f.repo, dir: NodePath.join(f.releases, "abcdefabcdef") };
    const scope = gateScopeOf(v, f.mobile);
    NodeAssert.equal(scope.action, "run");
    NodeAssert.match(scope.reason, /is not a commit/);
    const cfg = { currentTxt: NodePath.join(f.releases, "current.txt") };
    const problems = skipEvidenceProblems(
      cfg,
      { "repo-root": f.repo, release: f.mobile },
      skipEvidence(f.base, ["apps/hbots-mobile/app.json"]),
    );
    NodeAssert.match(problems.join(" "), /cannot verify skipped gates/);
  });
});

NodeTest.test("the collector classifies a real mobile-only range", () => {
  withFixture((f) => {
    const v = { repo: f.repo, dir: NodePath.join(f.releases, "abcdefabcdef") };
    const scope = gateScopeOf(v, f.mobile);
    NodeAssert.equal(scope.action, "skip");
    NodeAssert.equal(scope.baseSha, f.base);
    NodeAssert.deepEqual(scope.changedPaths, ["apps/hbots-mobile/app.json"]);
  });
});
