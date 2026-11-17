// Replays known fix commits and probes against the release planner. Each entry pins what the
// planner answers today: a hit runs every test the change must run, a miss is a known gap.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { fsReader } from "../lib/serverTestSelect.mjs";
import { cachedReader, replay } from "./plannerReplay.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(HERE, "fixtures/planner-replay.json"), "utf8"),
);
const reader = cachedReader(fsReader(NodePath.resolve(HERE, "../../../../..")));

const entries = [...fixture.cases, ...fixture.probes];
for (const entry of entries)
  NodeTest.it(`${entry.id}: ${entry.expect ?? "plan"} ${entry.missClass ?? ""}`, () => {
    const result = replay(entry, reader);
    if (entry.expect)
      NodeAssert.equal(
        result.hit ? "hit" : "miss",
        entry.expect,
        `${entry.id} missed now: ${result.missed.join(", ") || "none"}`,
      );
    if (entry.plan) NodeAssert.deepEqual(result.shape, entry.plan, `${entry.id} plan shape`);
  });

NodeTest.it("calls a plan that skips the guarding check a miss", () => {
  const verdict = replay(
    {
      changedPaths: ["apps/hbots-mobile/README.md"],
      mustRun: ["apps/hbots-mobile/src/pairing.test.ts"],
    },
    reader,
  );
  NodeAssert.deepEqual(
    [verdict.hit, verdict.missed],
    [false, ["apps/hbots-mobile/src/pairing.test.ts"]],
  );
});
