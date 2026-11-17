import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { parseList, planLane } from "../server-test-lane.mjs";

const iso = ["src/a/One.test.ts", "src/b/Two.test.ts"];

NodeTest.test("list keeps paths and drops comments and blanks", () => {
  NodeAssert.deepEqual(parseList("# why\nsrc/a/One.test.ts # leak\n\n  src/b/Two.test.ts\n"), iso);
});

NodeTest.test(
  "all: reuse run excludes the isolated files, then the isolated lane runs them",
  () => {
    const runs = planLane("all", ["--shard=1/2", "src/a", "src/c"], iso);
    NodeAssert.deepEqual(runs[0], [
      "test",
      "run",
      "--no-isolate",
      "--exclude",
      "src/a/One.test.ts",
      "--exclude",
      "src/b/Two.test.ts",
      "--shard=1/2",
      "src/a",
      "src/c",
    ]);
    NodeAssert.deepEqual(runs[1], ["test", "run", "--shard=1/2", "src/a/One.test.ts"]);
    NodeAssert.equal(runs.length, 2);
  },
);

NodeTest.test("a gate with no filter runs every isolated file", () => {
  const runs = planLane("all", ["--shard=2/2"], iso);
  NodeAssert.deepEqual(runs[1], ["test", "run", "--shard=2/2", ...iso]);
});

NodeTest.test("selected files outside the list start no isolated lane", () => {
  const runs = planLane("all", ["src/c/Three.test.ts"], iso);
  NodeAssert.equal(runs.length, 1);
});

NodeTest.test("a selected isolated file runs only in the isolated lane", () => {
  const runs = planLane("all", ["src/b/Two.test.ts", "src/c/Three.test.ts"], iso);
  NodeAssert.ok(runs[0].includes("--exclude"));
  NodeAssert.deepEqual(runs[1], ["test", "run", "src/b/Two.test.ts"]);
});

NodeTest.test("reuse off is one plain isolated run", () => {
  NodeAssert.deepEqual(planLane("all", ["--shard=1/2", "src"], iso, { reuse: false }), [
    ["test", "run", "--shard=1/2", "src"],
  ]);
});

NodeTest.test("an empty list still reuses", () => {
  NodeAssert.deepEqual(planLane("all", ["src"], []), [["test", "run", "--no-isolate", "src"]]);
});

NodeTest.test("unknown lane is refused", () => {
  NodeAssert.throws(() => planLane("both", [], iso), /unknown lane/);
});
