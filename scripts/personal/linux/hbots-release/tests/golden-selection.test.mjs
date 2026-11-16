// The ratchet for the server-tests selector. The golden file lists, per probe path,
// the tests that must be selected when that one path changes. Three reviews each
// found a silent skip the unit tests did not name, so this pins the whole
// selection of the paths they probed. Growth is allowed, loss is not: a selected
// test that the golden names and the planner no longer selects fails the test.
//
// A golden test that no longer exists in the tree is skipped (a deleted test cannot
// be selected). To grow the golden after a legitimate change, run
//   GOLDEN_WRITE=1 node --test scripts/personal/linux/hbots-release/tests/golden-selection.test.mjs
// and review the diff: it may only add tests.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { planChecks } from "../lib/gateScope.mjs";
import { fsReader } from "../lib/serverTestSelect.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO = NodePath.resolve(HERE, "../../../../..");
const GOLDEN = NodePath.join(HERE, "golden/server-tests-selection.json");

// Paths from the three Verifier reviews, plus ordinary server files across folders.
const PROBES = [
  // the entry and its helpers
  "apps/server/src/bin.ts",
  "apps/server/src/binMain.ts",
  "apps/server/src/server.ts",
  "apps/server/src/personal/PersonalBotService.ts",
  "apps/server/src/personal/PersonalBotRepository.ts",
  // the mobile and shared files that server tests mock or import
  "apps/hbots-mobile/src/pairing.ts",
  "apps/hbots-mobile/src/dpop.ts",
  "packages/shared/src/dpop.ts",
  "packages/shared/src/Array.ts",
  "packages/shared/src/AgentScope.ts",
  "packages/effect-acp/src/agent.ts",
  // barrel and export-star cases
  "packages/contracts/src/index.ts",
  "packages/contracts/src/assets.ts",
  "packages/contracts/src/personalChoices.ts",
  "apps/server/src/orchestration-v2/testkit/fixtures/index.ts",
  // fixtures, a doc a test reads, setup and config files
  "apps/server/src/orchestration-v2/testkit/fixtures/acp_titled_multiselect/input.ts",
  "apps/server/src/orchestration-v2/testkit/fixtures/acp_elicitation/registry_transcript.ndjson",
  "apps/server/integration/fixtures/transferBudget.ts",
  "docs/user/t3-connect-troubleshooting.md",
  "apps/server/src/testUtils/gitConfig.setup.ts",
  "apps/server/src/testUtils/managedServiceEnv.setup.ts",
  "packages/shared/src/testing/xdgGlobalSetup.ts",
  "apps/server/vite.config.ts",
  "apps/server/tsconfig.json",
  "apps/server/package.json",
  // a changed test selects itself
  "apps/server/src/personal/projects/projectText.test.ts",
  "apps/server/src/provider/CodexManagedRuntime.test.ts",
  // ordinary server files across the gate folders
  "apps/server/src/persistence/Migrations.ts",
  "apps/server/src/personal/tasks/PersonalTaskService.ts",
  "apps/server/src/personal/push/PersonalPushService.ts",
  "apps/server/src/personal/projects/projectText.ts",
  "apps/server/src/provider/DocumentText.ts",
  "apps/server/src/workspace/HostFilePaths.ts",
  "apps/server/src/personal/browser/PersonalBrowser.ts",
  "apps/server/src/mcp/McpToolAccess.ts",
  "apps/server/src/preview/Manager.ts",
  "apps/server/src/cloud/CloudLink.ts",
  "apps/server/src/assets/AssetAccess.ts",
];

// A whole plan runs every test, so it is recorded as "whole" and never counts as a loss.
const WHOLE = "whole";
const plan = (file) =>
  planChecks([file], { reader: fsReader(REPO) }).plans.find((entry) => entry.id === "server-tests");
const select = (file) => {
  const found = plan(file);
  return found.mode === "whole" ? WHOLE : found.args;
};

const readGolden = () => JSON.parse(NodeFS.readFileSync(GOLDEN, "utf8"));

if (process.env.GOLDEN_WRITE === "1") {
  // Growth only: keep every test the file already names that still exists.
  const old = NodeFS.existsSync(GOLDEN) ? readGolden() : {};
  const next = {};
  for (const file of PROBES) {
    if (!NodeFS.existsSync(NodePath.join(REPO, file))) continue;
    const now = select(file);
    // a path that was whole stays whole in the golden: going narrower is a loss
    if (now === WHOLE || old[file] === WHOLE) {
      next[file] = WHOLE;
      continue;
    }
    const kept = (old[file] ?? []).filter((test) =>
      NodeFS.existsSync(NodePath.join(REPO, "apps/server", test)),
    );
    next[file] = [...new Set([...kept, ...now])].sort();
  }
  NodeFS.writeFileSync(GOLDEN, `${JSON.stringify(next, null, 2)}\n`);
}

NodeTest.test("every probe path still selects every test the golden names", () => {
  const golden = readGolden();
  const lost = [];
  for (const [file, tests] of Object.entries(golden)) {
    const picked = select(file);
    if (picked === WHOLE) continue;
    if (tests === WHOLE) {
      lost.push(`${file} was whole and now selects ${picked.length} tests`);
      continue;
    }
    const now = new Set(picked);
    for (const test of tests) {
      if (!NodeFS.existsSync(NodePath.join(REPO, "apps/server", test))) continue;
      if (!now.has(test)) lost.push(`${file} lost ${test}`);
    }
  }
  NodeAssert.deepEqual(lost.slice(0, 20), [], `${lost.length} selections lost`);
});

NodeTest.test("the golden covers every probe path, and bin.ts selects 300 or more", () => {
  const golden = readGolden();
  for (const file of PROBES)
    if (NodeFS.existsSync(NodePath.join(REPO, file)))
      NodeAssert.ok(file in golden, `${file} has no golden entry`);
  NodeAssert.ok(golden["apps/server/src/bin.ts"].length >= 300);
});
