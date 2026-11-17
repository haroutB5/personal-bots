// A module the runner imports must be pinned, or an edited copy in the runner dir passes the pin check.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { currentPins } from "../lib/pins.mjs";
import { ROOT } from "./scratchRepo.mjs";

const UNPINNED_BEFORE_THIS_CHANGE = ["proc.mjs", "util.mjs"];
const TOOLS = ["check-release-notes.mjs", "check-gate-evidence.mjs", "gate-common.mjs", "ops-common.mjs", "notify-release.mjs"];

const pinned = () => {
  const toolsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pins-"));
  try {
    for (const name of TOOLS) NodeFS.writeFileSync(NodePath.join(toolsDir, name), name);
    return Object.keys(currentPins({ here: ROOT, toolsDir }).files);
  } finally {
    NodeFS.rmSync(toolsDir, { recursive: true, force: true });
  }
};

NodeTest.describe("the pinned runner modules", () => {
  NodeTest.it("pins the stamp and gate definition modules the planner loads", () => {
    const files = pinned();
    NodeAssert.ok(files.includes("lib/verifyStamp.mjs"), "lib/verifyStamp.mjs");
    NodeAssert.ok(files.includes("lib/gateDefs.mjs"), "lib/gateDefs.mjs");
  });

  NodeTest.it("pins every module a pinned module imports, bar the two that were unpinned before", () => {
    const files = pinned();
    const missing = [];
    for (const file of files.filter((name) => name.startsWith("lib/"))) {
      const source = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8");
      for (const [, name] of source.matchAll(/(?:from|import)\s*\(?\s*"\.\/([\w-]+\.mjs)"/g))
        if (!files.includes(`lib/${name}`) && !UNPINNED_BEFORE_THIS_CHANGE.includes(name)) missing.push(`${file} imports ${name}`);
    }
    NodeAssert.deepEqual(missing, []);
  });
});
