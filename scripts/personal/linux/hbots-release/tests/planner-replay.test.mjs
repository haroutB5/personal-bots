// Replays known fix commits and probes against the release planner. Each entry
// pins what the planner answers today: a hit runs every test the change must run,
// a miss is a known gap. Run with node --test.
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { fsReader } from "../lib/serverTestSelect.mjs";
import { cachedReader, replay } from "./plannerReplay.mjs";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const REPO = NodePath.resolve(HERE, "../../../../..");
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(HERE, "fixtures/planner-replay.json"), "utf8"),
);
const reader = cachedReader(fsReader(REPO));

NodeTest.describe("planner replay: fix commits", () => {
  for (const entry of fixture.cases)
    NodeTest.it(
      `${entry.id} ${entry.commit}: ${entry.expect}${entry.missClass ? ` (${entry.missClass})` : ""}`,
      () => {
        const result = replay(entry, reader);
        NodeAssert.equal(
          result.hit ? "hit" : "miss",
          entry.expect,
          `${entry.id} is expected ${entry.expect}; missed tests now: ${result.missed.join(", ") || "none"}`,
        );
      },
    );
});

NodeTest.describe("planner replay: probes", () => {
  for (const entry of fixture.probes)
    NodeTest.it(
      `${entry.id}: ${entry.expect ?? "plan"}${entry.missClass ? ` (${entry.missClass})` : ""}`,
      () => {
        const result = replay(entry, reader);
        if (entry.expect)
          NodeAssert.equal(
            result.hit ? "hit" : "miss",
            entry.expect,
            `${entry.id}: ${entry.note ?? ""}`,
          );
        NodeAssert.deepEqual(result.shape, entry.plan, `${entry.id} plan shape`);
      },
    );
});

NodeTest.describe("planner replay: the judge", () => {
  NodeTest.it("calls a plan that skips the guarding check a miss", () => {
    const verdict = replay(
      {
        changedPaths: ["apps/hbots-mobile/README.md"],
        mustRun: ["apps/hbots-mobile/src/pairing.test.ts"],
      },
      reader,
    );
    NodeAssert.equal(verdict.hit, false);
    NodeAssert.deepEqual(verdict.missed, ["apps/hbots-mobile/src/pairing.test.ts"]);
  });

  NodeTest.it("calls a plan that runs the guarding check whole a hit", () => {
    const verdict = replay(
      {
        changedPaths: ["apps/hbots-mobile/src/pairing.ts"],
        mustRun: ["apps/hbots-mobile/src/pairing.test.ts"],
      },
      reader,
    );
    NodeAssert.equal(verdict.hit, true);
  });

  NodeTest.it("keeps the fixture totals honest", () => {
    const all = [...fixture.cases, ...fixture.probes].filter((entry) => entry.expect);
    NodeAssert.ok(fixture.cases.length >= 200, "the replay lost most of its cases");
    NodeAssert.ok(
      all.some((entry) => entry.expect === "miss") && all.some((entry) => entry.expect === "hit"),
    );
    for (const entry of all)
      if (entry.expect === "miss")
        NodeAssert.ok(entry.missClass, `${entry.id} is an expected miss with no class`);
  });
});
