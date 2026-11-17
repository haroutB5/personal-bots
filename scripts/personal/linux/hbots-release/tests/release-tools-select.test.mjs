// Which release-tool tests a changed file selects: the tests beside it and the tests that name it.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { planChecks } from "../lib/gateScope.mjs";

const UNITS = "scripts/personal/node/test/units.test.mjs";
const DSH = "scripts/personal/node/test/install-dsh.test.mjs";
const SNAPSHOT = "scripts/personal/sqlite-snapshot.test.cjs";
const TOOLS = "scripts/personal/linux/dev-team-tools/tools.test.mjs";

const files = {
  [UNITS]: 'join(root, "install-units.sh"); join(root, "systemd");',
  [DSH]: 'resolve(HERE, "..", "..", "dsh-runtime"); join(dir, "package.json");',
  [SNAPSHOT]: "path.join(__dirname,'release-runner/hbots-release/release-db-check.cjs')",
  [TOOLS]: "join(root,'scripts/personal/node/gates-linux.scoped.json')",
  "scripts/personal/node/test/paths.test.mjs": 'import "./index.mjs";',
};
const reader = {
  exists: (file) => file in files,
  read: (file) => files[file] ?? null,
  listFiles: (dir) => Object.keys(files).filter((file) => file.startsWith(`${dir}/`)),
  prefetch: () => {},
};
const releaseTools = (path) =>
  planChecks([path], { reader }).plans.find((plan) => plan.id === "release-tools");

NodeTest.describe("release-tools selection by what a test reads", () => {
  const reads = [
    ["a script outside the test's folder", "scripts/personal/linux/install-units.sh", UNITS],
    ["the folder above a changed file", "scripts/personal/linux/systemd/hbots.service.in", UNITS],
    ["a gates file by its path", "scripts/personal/node/gates-linux.scoped.json", TOOLS],
    ["a dsh-runtime file", "scripts/personal/dsh-runtime/hbots-deny-plugin.mjs", DSH],
    [
      "a release-runner helper",
      "scripts/personal/release-runner/hbots-release/release-db-check.cjs",
      SNAPSHOT,
    ],
  ];
  for (const [name, changed, test] of reads)
    NodeTest.it(`selects the test that names ${name}`, () => {
      const plan = releaseTools(changed);
      NodeAssert.equal(plan.mode, "selected");
      NodeAssert.ok(plan.args.includes(test), plan.args.join(", "));
    });

  NodeTest.it("ignores a file name every folder has, and skips a file no test reads", () => {
    NodeAssert.deepEqual(releaseTools("scripts/personal/dsh-runtime/index.mjs").args, [DSH]);
    const none = releaseTools("scripts/personal/release-runner/hbots-release/tree-hash.cjs");
    NodeAssert.equal(none.mode, "skip");
    NodeAssert.match(none.reason, /selector found nothing to run/);
  });
});
