// Fixtures for the v1 reach census. Run:
//   node --test scripts/personal/sync/v1-reach.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

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
  assert.equal(isPersonalPath("apps/server/src/personal/tasks/taskCore.ts"), true);
  assert.equal(isPersonalPath("apps/server/src/mcp/toolkits/personal/handlers.ts"), true);
  assert.equal(isPersonalPath("packages/contracts/src/personalBots.ts"), true);
  assert.equal(isPersonalPath("apps/server/src/provider/Layers/ClaudeAdapter.ts"), false);
  assert.equal(isPersonalPath("apps/server/src/personal/tasks/taskCore.test.ts"), false);
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

  assert.deepEqual(rows, [
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
  assert.deepEqual(rows, [
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
  assert.deepEqual([...census.keys()], ["a.ts", "b.ts"]);
  assert.equal(census.get("b.ts").length, 2);
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
  assert.deepEqual(result.unexpected, ["b.ts"]);
  assert.deepEqual(result.indirect, [{ path: "c.ts", reason: "through TaskCore" }]);
  assert.deepEqual(result.stale, ["c.ts"]);
});

test("baseline parsing rejects duplicates and orphan reasons", () => {
  assert.throws(() => parseBaseline({ files: ["a.ts", "a.ts"] }), /duplicate file/);
  assert.throws(
    () => parseBaseline({ files: ["a.ts"], indirectReasons: { "b.ts": "why" } }),
    /not in files/,
  );
  assert.throws(() => parseBaseline({}), /files array/);
});
