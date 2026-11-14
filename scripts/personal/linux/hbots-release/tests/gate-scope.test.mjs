// The gate-scope allowlist and the seal's skip check. Run with node --test.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import { classifyGateScope, verifySkippedGates, GATE_INPUTS } from "../lib/gateScope.mjs";
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

const ALL = ["server-tests", "e2e", "hbots-mobile-kotlin"];
const skipOf = (paths) => classifyGateScope(paths).skip;
const GATES_JSON = NodePath.join(ROOT, "../../node/gates-linux.json");

NodeTest.test("a mobile-only diff skips server-tests and e2e and runs kotlin", () => {
  const scope = classifyGateScope(["apps/hbots-mobile/app.json"]);
  NodeAssert.deepEqual(scope.skip, ["server-tests", "e2e"]);
  NodeAssert.deepEqual(scope.changedPaths, ["apps/hbots-mobile/app.json"]);
  NodeAssert.match(scope.reasons["server-tests"], /^no changed path is an input of server-tests: /);
  NodeAssert.match(
    scope.reasons["hbots-mobile-kotlin"],
    /hbots-mobile-kotlin inputs changed: apps\/hbots-mobile\/app\.json/,
  );
});

NodeTest.test("a docs-only diff skips every skippable gate", () => {
  NodeAssert.deepEqual(skipOf(["docs/releases/HANDOFF-1672.md"]), ALL);
});

NodeTest.test("markdown outside docs and code trees is not an input", () => {
  NodeAssert.deepEqual(skipOf(["README.md", "scripts/personal/README.md"]), ALL);
  NodeAssert.deepEqual(skipOf(["README.md", "apps/hbots-mobile/README.md"]), [
    "server-tests",
    "e2e",
  ]);
});

NodeTest.test("markdown inside a code tree is a code input", () => {
  NodeAssert.equal(skipOf(["apps/server/README.md"]).includes("server-tests"), false);
  NodeAssert.equal(skipOf(["apps/web/src/x.md"]).includes("e2e"), false);
  NodeAssert.equal(skipOf(["packages/shared/y.md"]).includes("server-tests"), false);
});

NodeTest.test("mobile and doc files a server gate reads run server-tests and e2e", () => {
  for (const file of [
    "apps/hbots-mobile/src/pairing.ts",
    "apps/hbots-mobile/src/dpop.ts",
    "docs/user/t3-connect-troubleshooting.md",
  ]) {
    const scope = classifyGateScope(["apps/hbots-mobile/src/App.tsx", file]);
    NodeAssert.deepEqual(scope.skip, [], file);
    NodeAssert.match(scope.reasons["server-tests"], new RegExp(file.replaceAll(".", "\\.")));
  }
});

NodeTest.test("mobile plus packages/shared runs server-tests and e2e", () => {
  const scope = classifyGateScope([
    "apps/hbots-mobile/app.json",
    "packages/shared/src/testing/providerEnv.ts",
  ]);
  NodeAssert.deepEqual(scope.skip, []);
  NodeAssert.match(
    scope.reasons["server-tests"],
    /packages\/shared\/src\/testing\/providerEnv\.ts/,
  );
});

NodeTest.test("a server diff runs every skippable gate except kotlin", () => {
  NodeAssert.deepEqual(skipOf(["apps/server/src/index.ts"]), ["hbots-mobile-kotlin"]);
});

NodeTest.test("a web-only diff runs e2e only", () => {
  NodeAssert.deepEqual(skipOf(["apps/web/src/main.tsx"]), ["server-tests", "hbots-mobile-kotlin"]);
});

NodeTest.test("personal-client is not a server-tests input but is an e2e input", () => {
  NodeAssert.deepEqual(skipOf(["packages/personal-client/src/index.ts"]), [
    "server-tests",
    "hbots-mobile-kotlin",
  ]);
});

NodeTest.test("a release bump with mobile changes skips server-tests only", () => {
  const scope = classifyGateScope([
    "apps/hbots-mobile/package.json",
    "apps/hbots-mobile/src/shell/ServerUpdateBanner.tsx",
    "docs/releases/HANDOFF-16719.md",
    "scripts/personal/app-version.txt",
  ]);
  NodeAssert.deepEqual(scope.skip, ["server-tests"]);
  NodeAssert.match(scope.reasons.e2e, /scripts\/personal\/app-version\.txt/);
});

NodeTest.test("the parity matrix is no skippable gate's input", () => {
  NodeAssert.deepEqual(skipOf(["scripts/personal/parity/parity.json", "docs/x.md"]), ALL);
  NodeAssert.deepEqual(skipOf(["scripts/personal/parity/parity-matrix.mjs"]), []);
});

NodeTest.test("root config and patches run every skippable gate", () => {
  for (const file of ["package.json", "pnpm-lock.yaml", "tsconfig.base.json", "patches/x.patch"]) {
    NodeAssert.deepEqual(skipOf([file]), [], file);
  }
});

NodeTest.test("a path outside every known area runs every gate", () => {
  for (const file of [
    "scripts/personal/node/gates-linux.json",
    "infra/main.tf",
    "native/resource-monitor/src/main.rs",
    "apps/desktop/src/main.ts",
    ".github/workflows/ci.yml",
    "brand-new-area/file.ts",
  ]) {
    const scope = classifyGateScope(["docs/releases/HANDOFF-1672.md", file]);
    NodeAssert.deepEqual(scope.skip, [], file);
    for (const id of ALL) NodeAssert.match(scope.reasons[id], /outside every known area/, file);
  }
});

NodeTest.test("an empty diff runs", () => {
  NodeAssert.deepEqual(skipOf([]), []);
});

NodeTest.test("an unsafe path runs", () => {
  NodeAssert.deepEqual(skipOf(["apps/hbots-mobile/../apps/server/src/index.ts"]), []);
});

NodeTest.test("every table row names a gate the Linux gate list defines", () => {
  const ids = JSON.parse(NodeFS.readFileSync(GATES_JSON, "utf8")).map((gate) => gate.id);
  for (const id of Object.keys(GATE_INPUTS)) NodeAssert.ok(ids.includes(id), id);
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
      /must run it: server-tests inputs changed: apps\/server\/src\/index\.ts/,
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
    NodeAssert.deepEqual(scope.skip, []);
    NodeAssert.match(scope.summary, /is not a commit/);
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
    NodeAssert.deepEqual(scope.skip, ["server-tests", "e2e"]);
    NodeAssert.equal(scope.baseSha, f.base);
    NodeAssert.deepEqual(scope.changedPaths, ["apps/hbots-mobile/app.json"]);
  });
});

NodeTest.test(
  "the seal refuses a kotlin skip on a mobile diff and accepts one on a server diff",
  () => {
    withFixture((f) => {
      const mobilePaths = ["apps/hbots-mobile/app.json"];
      NodeAssert.match(
        verifySkippedGates({
          evidence: skipEvidence(f.base, mobilePaths, ["hbots-mobile-kotlin"]),
          liveSha: f.base,
          releaseSha: f.mobile,
          changedPaths: mobilePaths,
        }).join(" "),
        /evidence skips hbots-mobile-kotlin but the live-to-release diff must run it/,
      );
      const serverPaths = ["apps/server/src/index.ts"];
      NodeAssert.deepEqual(
        verifySkippedGates({
          evidence: skipEvidence(f.mobile, serverPaths, ["hbots-mobile-kotlin"]),
          liveSha: f.mobile,
          releaseSha: f.server,
          changedPaths: serverPaths,
        }),
        [],
      );
    });
  },
);
