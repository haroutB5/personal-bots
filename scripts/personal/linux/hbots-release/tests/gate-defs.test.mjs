// The gate commands come from where the change left trunk, so a change cannot edit the check that judges it.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { GATES_FILE, gateChanges, gateDefsFromBase } from "../lib/gateDefs.mjs";

const gate = (id, command, extra = {}) => ({ id, kind: "vitest", cwd: "apps/web", commands: [command], ...extra });
const gatesFile = (...defs) => `${JSON.stringify(defs, null, 2)}\n`;

NodeTest.describe("the gate commands of one change", () => {
  const before = gatesFile(gate("web-tests", "vp test run base-command"), gate("web-tsc", "tsc --noEmit"));

  NodeTest.it("runs the base command and names the gate a change edited", () => {
    const edited = gatesFile(gate("web-tests", "echo head-command"), gate("web-tsc", "tsc --noEmit"));
    const found = gateDefsFromBase({ baseSource: before, headSource: edited });
    NodeAssert.deepEqual(found.defs.map((def) => def.commands), [["vp test run base-command"], ["tsc --noEmit"]]);
    NodeAssert.deepEqual(found.changes, [{ id: "web-tests", kind: "edited" }]);
    NodeAssert.deepEqual(gateChanges(found.changes), [
      "gate command changed in this change: web-tests; the base command runs",
    ]);
  });

  NodeTest.it("names an added gate and a removed gate, and nothing for an untouched file", () => {
    const found = gateDefsFromBase({
      baseSource: before,
      headSource: gatesFile(gate("web-tsc", "tsc --noEmit"), gate("lint", "oxlint")),
    });
    NodeAssert.deepEqual(found.changes, [
      { id: "lint", kind: "added" },
      { id: "web-tests", kind: "removed" },
    ]);
    NodeAssert.deepEqual(gateChanges(found.changes), [
      "gate added in this change: lint; it has no base command and does not run here",
      "gate removed in this change: web-tests; the base command runs",
    ]);
    NodeAssert.deepEqual(gateDefsFromBase({ baseSource: before, headSource: before }).changes, []);
  });

  NodeTest.it("names the deletion of the whole gates file, and the base gates still run", () => {
    const found = gateDefsFromBase({ baseSource: before, headSource: null });
    NodeAssert.equal(found.defs.length, 2);
    NodeAssert.deepEqual(found.changes, [{ id: GATES_FILE, kind: "file-deleted" }]);
    NodeAssert.deepEqual(gateChanges(found.changes), [
      `gates file deleted in this change: ${GATES_FILE}; the base commands run`,
    ]);
  });

  NodeTest.it("tells a branch from before the gates file to merge trunk", () => {
    NodeAssert.throws(
      () => gateDefsFromBase({ baseSource: null, headSource: before }),
      /no gates file at base: .*\. This branch left trunk before that file existed\. Merge trunk into the branch, then plan again\./,
    );
  });

  NodeTest.it("counts a change to any field a gate runs by, not only its commands", () => {
    const moved = gatesFile(gate("web-tests", "vp test run base-command", { cwd: "apps/other" }), gate("web-tsc", "tsc --noEmit"));
    NodeAssert.deepEqual(gateDefsFromBase({ baseSource: before, headSource: moved }).changes, [
      { id: "web-tests", kind: "edited" },
    ]);
  });

  NodeTest.it("reads an unreadable head file as a problem, and an unreadable base file as a refusal", () => {
    const found = gateDefsFromBase({ baseSource: before, headSource: "{ nope" });
    NodeAssert.equal(found.defs.length, 2);
    NodeAssert.match(found.problems.join(" "), /gates file at head is not valid JSON/);
    NodeAssert.throws(() => gateDefsFromBase({ baseSource: null, headSource: before }), /no gates file at base/);
    NodeAssert.throws(() => gateDefsFromBase({ baseSource: "{ nope", headSource: before }), /not valid JSON/);
  });
});
