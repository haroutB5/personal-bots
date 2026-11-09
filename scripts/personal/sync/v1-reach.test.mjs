// Fixtures for the v1 reach census. Run:
//   node --test scripts/personal/sync/v1-reach.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";
const { test } = NodeTest;

import {
  censusFiles,
  classifyReach,
  DEFAULT_BASELINE_PATH,
  isPersonalPath,
  parseBaseline,
  tableReadsFor,
} from "./v1-reach.mjs";

test("scope covers personal code, the personal contract and the personal toolkit", () => {
  NodeAssert.equal(isPersonalPath("apps/server/src/personal/tasks/taskCore.ts"), true);
  NodeAssert.equal(isPersonalPath("apps/server/src/mcp/toolkits/personal/handlers.ts"), true);
  NodeAssert.equal(isPersonalPath("packages/contracts/src/personalBots.ts"), true);
  NodeAssert.equal(isPersonalPath("apps/server/src/provider/Layers/ClaudeAdapter.ts"), false);
  NodeAssert.equal(isPersonalPath("apps/server/src/personal/tasks/taskCore.test.ts"), false);
});

test("a source read of a v1 table is evidence, one row per table", () => {
  const rows = tableReadsFor({
    file: "apps/server/src/personal/b.ts",
    source: "SELECT * FROM projection_thread_messages; SELECT * FROM projection_threads;",
  });
  NodeAssert.deepEqual(rows, [
    { path: "apps/server/src/personal/b.ts", kind: "tables", detail: "projection_threads" },
    { path: "apps/server/src/personal/b.ts", kind: "tables", detail: "projection_thread_messages" },
  ]);
});

test("a file with no v1 table read has no evidence", () => {
  NodeAssert.deepEqual(
    tableReadsFor({
      file: "apps/server/src/personal/c.ts",
      source: "SELECT * FROM personal_bot_threads;",
    }),
    [],
  );
});

test("two table reads for one file become one census entry", () => {
  const census = censusFiles([
    { path: "b.ts", kind: "tables", detail: "projection_turns" },
    { path: "b.ts", kind: "tables", detail: "projection_threads" },
    { path: "a.ts", kind: "tables", detail: "projection_thread_messages" },
  ]);
  NodeAssert.deepEqual([...census.keys()], ["a.ts", "b.ts"]);
  NodeAssert.equal(census.get("b.ts").length, 2);
});

test("a new direct hit is unexpected, an unset baseline entry is stale", () => {
  const expected = new Map([["a.ts", null]]);
  const result = classifyReach({
    census: censusFiles([{ path: "b.ts", kind: "tables", detail: "projection_threads" }]),
    expected,
    exists: (path) => path !== "a.ts",
  });
  NodeAssert.deepEqual(result.unexpected, ["b.ts"]);
  NodeAssert.deepEqual(result.stale, ["a.ts"]);
});

test("baseline parsing rejects duplicates and orphan reasons", () => {
  NodeAssert.throws(() => parseBaseline({ files: ["a.ts", "a.ts"] }), /duplicate file/);
  NodeAssert.throws(
    () => parseBaseline({ files: ["a.ts"], indirectReasons: { "b.ts": "why" } }),
    /not in files/,
  );
  NodeAssert.throws(() => parseBaseline({}), /files array/);
});

test("the committed baseline is empty", () => {
  NodeAssert.deepEqual(JSON.parse(NodeFS.readFileSync(DEFAULT_BASELINE_PATH, "utf8")), {
    files: [],
    indirectReasons: {},
  });
});
