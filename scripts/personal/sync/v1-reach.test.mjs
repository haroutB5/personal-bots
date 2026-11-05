// Fixtures for the v1 reach census. Run:
//   node --test scripts/personal/sync/v1-reach.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
const { test } = NodeTest;

import {
  brokenImportsFor,
  censusFiles,
  classifyReach,
  isPersonalPath,
  parseBaseline,
  resolveImportTarget,
  tableReadsFor,
} from "./v1-reach.mjs";

const set = (...files) => new Set(files);

test("scope covers personal code, the personal contract and the personal toolkit", () => {
  NodeAssert.equal(isPersonalPath("apps/server/src/personal/tasks/taskCore.ts"), true);
  NodeAssert.equal(isPersonalPath("apps/server/src/mcp/toolkits/personal/handlers.ts"), true);
  NodeAssert.equal(isPersonalPath("packages/contracts/src/personalBots.ts"), true);
  NodeAssert.equal(isPersonalPath("apps/server/src/provider/Layers/ClaudeAdapter.ts"), false);
  NodeAssert.equal(isPersonalPath("apps/server/src/personal/tasks/taskCore.test.ts"), false);
});

test("a relative import that upstream deleted is evidence", () => {
  const trunkFiles = set(
    "apps/server/src/personal/a.ts",
    "apps/server/src/orchestration/Layers/OrchestrationEngine.ts",
    "apps/server/src/orchestration/Layers/Kept.ts",
  );
  const source = [
    'import { engine } from "../orchestration/Layers/OrchestrationEngine.ts";',
    'import { kept } from "../orchestration/Layers/Kept.ts";',
    'import { added } from "./Added.ts";',
  ].join("\n");
  const rows = brokenImportsFor({
    file: "apps/server/src/personal/a.ts",
    source,
    trunkFiles,
    upstreamFiles: set(
      "apps/server/src/personal/a.ts",
      "apps/server/src/orchestration/Layers/Kept.ts",
    ),
    baseFiles: set(
      "apps/server/src/personal/a.ts",
      "apps/server/src/orchestration/Layers/OrchestrationEngine.ts",
      "apps/server/src/orchestration/Layers/Kept.ts",
    ),
    resolveImport: resolveImportTarget,
  });

  NodeAssert.deepEqual(rows, [
    {
      path: "apps/server/src/personal/a.ts",
      kind: "imports",
      detail: "apps/server/src/orchestration/Layers/OrchestrationEngine.ts",
    },
  ]);
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

test("two evidence kinds for one file become one census entry", () => {
  const census = censusFiles([
    { path: "b.ts", kind: "imports", detail: "x" },
    { path: "b.ts", kind: "tables", detail: "y" },
    { path: "a.ts", kind: "imports", detail: "z" },
  ]);
  NodeAssert.deepEqual([...census.keys()], ["a.ts", "b.ts"]);
  NodeAssert.equal(census.get("b.ts").length, 2);
});

test("a new direct hit is unexpected, an unset baseline entry is stale", () => {
  const expected = new Map([
    ["a.ts", null],
    ["c.ts", "through TaskCore"],
  ]);
  const result = classifyReach({
    census: censusFiles([
      { path: "a.ts", kind: "imports", detail: "x" },
      { path: "b.ts", kind: "tables", detail: "y" },
    ]),
    expected,
    exists: (path) => path !== "c.ts",
  });
  NodeAssert.deepEqual(result.unexpected, ["b.ts"]);
  NodeAssert.deepEqual(result.indirect, [{ path: "c.ts", reason: "through TaskCore" }]);
  NodeAssert.deepEqual(result.stale, ["c.ts"]);
});

test("baseline parsing rejects duplicates and orphan reasons", () => {
  NodeAssert.throws(() => parseBaseline({ files: ["a.ts", "a.ts"] }), /duplicate file/);
  NodeAssert.throws(
    () => parseBaseline({ files: ["a.ts"], indirectReasons: { "b.ts": "why" } }),
    /not in files/,
  );
  NodeAssert.throws(() => parseBaseline({}), /files array/);
});
