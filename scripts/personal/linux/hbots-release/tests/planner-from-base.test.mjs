// The planner command over scratch repos: the gate commands it prints come from where the branch left trunk.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { branch, planner, withRepo, write } from "./scratchRepo.mjs";

const GATES_FILE = "scripts/personal/node/gates-linux.scoped.json";
const gate = (id, command, extra = {}) => ({ id, kind: "vitest", cwd: "apps/web", commands: [command], ...extra });
const gatesFile = (...defs) => `${JSON.stringify(defs, null, 2)}\n`;
const seed = (...defs) => (repo) => {
  write(repo, GATES_FILE, gatesFile(...defs));
  write(repo, "apps/web/src/a.ts", "export const a = 1;\n");
};
const touch = (repo) => write(repo, "apps/web/src/a.ts", "export const a = 2;\n");

NodeTest.describe("the planner command over a real branch", () => {
  const run = (edit, flags = [], defs = [gate("web-tests", "vp test run base-command")]) => {
    let result;
    withRepo(seed(...defs), ({ repo, trunk }) => {
      branch(repo, "feat/x", () => edit(repo));
      result = planner(repo, trunk, "feat/x", "--commands", ...flags);
    });
    return result;
  };
  const editGate = (repo) => {
    touch(repo);
    write(repo, GATES_FILE, gatesFile(gate("web-tests", "echo head-command")));
  };

  NodeTest.it("prints the base command when the branch edits the gate command", () => {
    const result = run(editGate);
    NodeAssert.equal(result.code, 0, result.err);
    NodeAssert.match(result.out, /cd apps\/web && vp test run base-command/);
    NodeAssert.doesNotMatch(result.out, /head-command/);
    NodeAssert.match(result.err, /gate command changed in this change: web-tests; the base command runs/);
  });

  NodeTest.it("prints the same commands and no change line when the gate file is untouched", () => {
    const result = run(touch);
    NodeAssert.equal(result.code, 0, result.err);
    NodeAssert.match(result.out, /cd apps\/web && vp test run base-command/);
    NodeAssert.doesNotMatch(result.err, /gate command changed/);
  });

  NodeTest.it("names the change in the plain plan too", () => {
    let result;
    withRepo(seed(gate("web-tests", "vp test run base-command")), ({ repo, trunk }) => {
      branch(repo, "feat/x", () => editGate(repo));
      result = planner(repo, trunk, "feat/x");
    });
    NodeAssert.equal(result.code, 0, result.err);
    NodeAssert.match(result.out, /gate command changed in this change: web-tests; the base command runs/);
  });

  NodeTest.it("refuses to print commands when trunk has no gates file", () => {
    let result;
    withRepo(
      (repo) => write(repo, "apps/web/src/a.ts", "export const a = 1;\n"),
      ({ repo, trunk }) => {
        branch(repo, "feat/x", () => {
          touch(repo);
          write(repo, GATES_FILE, gatesFile(gate("web-tests", "echo head-command")));
        });
        result = planner(repo, trunk, "feat/x", "--commands");
      },
    );
    NodeAssert.equal(result.code, 2);
    NodeAssert.match(result.err, /no gates file at base/);
    NodeAssert.doesNotMatch(result.out, /head-command/);
  });

  NodeTest.it("tells a branch from before the gates file to merge trunk", () => {
    let result;
    withRepo(
      (repo) => write(repo, "apps/web/src/a.ts", "export const a = 1;\n"),
      ({ repo, trunk }) => {
        branch(repo, "feat/x", () => touch(repo));
        result = planner(repo, trunk, "feat/x", "--commands");
      },
    );
    NodeAssert.equal(result.code, 2);
    NodeAssert.equal(result.out, "");
    NodeAssert.match(result.err, /no gates file at base: scripts\/personal\/node\/gates-linux\.scoped\.json\. This branch left trunk before that file existed\. Merge trunk into the branch, then plan again\./);
  });

  NodeTest.it("names the deletion when the branch deletes the whole gates file, and still prints the base commands", () => {
    const result = run((repo) => {
      touch(repo);
      NodeFS.rmSync(NodePath.join(repo, GATES_FILE));
    });
    NodeAssert.equal(result.code, 0, result.err);
    NodeAssert.match(result.out, /cd apps\/web && vp test run base-command/);
    NodeAssert.match(result.err, /gates file deleted in this change: scripts\/personal\/node\/gates-linux\.scoped\.json; the base commands run/);
  });
});
