// Which release-tool tests a changed file selects: the tests beside it and the tests
// that name it. Run with node --test.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { planChecks } from "../lib/gateScope.mjs";

const UNITS = "scripts/personal/node/test/units.test.mjs";
const DSH = "scripts/personal/node/test/install-dsh.test.mjs";
const SNAPSHOT = "scripts/personal/sqlite-snapshot.test.cjs";
const TOOLS = "scripts/personal/linux/dev-team-tools/tools.test.mjs";

function treeOf(files) {
  return {
    exists: (file) => file in files,
    read: (file) => files[file] ?? null,
    listFiles: (dir) => Object.keys(files).filter((file) => file.startsWith(`${dir}/`)),
    prefetch: () => {},
  };
}

const reader = treeOf({
  [UNITS]: 'join(root, "install-units.sh"); join(root, "systemd");',
  [DSH]: 'resolve(HERE, "..", "..", "dsh-runtime"); join(dir, "package.json");',
  [SNAPSHOT]: "path.join(__dirname,'release-runner/hbots-release/release-db-check.cjs')",
  [TOOLS]: "join(root,'scripts/personal/node/gates-linux.scoped.json')",
  "scripts/personal/node/test/paths.test.mjs": 'import "./index.mjs";',
  "scripts/personal/linux/hbots-release/tests/gate-scope.test.mjs": "assert.ok(true)",
  "scripts/personal/linux/install-units.sh": "#!/bin/sh",
});

const releaseTools = (paths) =>
  planChecks(paths, { reader }).plans.find((plan) => plan.id === "release-tools");

NodeTest.describe("release-tools selection by what a test reads", () => {
  NodeTest.it("selects the test that names a changed script outside its own folder", () => {
    const plan = releaseTools(["scripts/personal/linux/install-units.sh"]);
    NodeAssert.equal(plan.mode, "selected");
    NodeAssert.ok(plan.args.includes(UNITS), plan.args.join(", "));
  });

  NodeTest.it("selects the test that names the folder above a changed file", () => {
    const plan = releaseTools(["scripts/personal/linux/systemd/hbots.service.in"]);
    NodeAssert.ok(plan.args.includes(UNITS), plan.args.join(", "));
  });

  NodeTest.it("plans a change under dsh-runtime for the test that installs it", () => {
    const plan = releaseTools(["scripts/personal/dsh-runtime/hbots-deny-plugin.mjs"]);
    NodeAssert.deepEqual(plan.args, [DSH]);
  });

  NodeTest.it("plans a change under release-runner for the test that runs its helper", () => {
    const plan = releaseTools([
      "scripts/personal/release-runner/hbots-release/release-db-check.cjs",
    ]);
    NodeAssert.deepEqual(plan.args, [SNAPSHOT]);
  });

  NodeTest.it("selects the tests that name a gates file by its path", () => {
    const plan = releaseTools(["scripts/personal/node/gates-linux.scoped.json"]);
    NodeAssert.ok(plan.args.includes(TOOLS), plan.args.join(", "));
  });

  NodeTest.it("does not select a test for a file name every folder has", () => {
    const plan = releaseTools(["scripts/personal/dsh-runtime/index.mjs"]);
    NodeAssert.equal(plan.mode, "selected");
    NodeAssert.deepEqual(plan.args, [DSH]);
  });

  NodeTest.it("skips a release-runner file that no test reads", () => {
    const plan = releaseTools(["scripts/personal/release-runner/hbots-release/tree-hash.cjs"]);
    NodeAssert.equal(plan.mode, "skip");
    NodeAssert.match(plan.reason, /selector found nothing to run/);
  });

  NodeTest.it("keeps the tests beside a changed file", () => {
    const plan = releaseTools(["scripts/personal/node/anything.mjs"]);
    NodeAssert.ok(plan.args.includes("scripts/personal/node/test/paths.test.mjs"));
  });
});
