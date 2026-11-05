// Fixtures for the B1 resolver rules. Run:
//   node --test scripts/personal/sync/v2-merge-resolve.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countPatchLines,
  hasBrokenImport,
  planFor,
  renamedIntoV2,
  targetPrFor,
} from "./v2-merge-resolve.mjs";

const plan = (overrides) =>
  planFor({ path: "apps/server/src/x.ts", seam: false, broken: false, ...overrides });

test("modify-delete takes the deletion and parks our diff", () => {
  assert.deepEqual(plan({ status: "UD" }), { action: "take-deletion", kind: "modify-delete" });
});

test("content conflicts outside the seam take upstream", () => {
  assert.deepEqual(plan({ status: "UU" }), { action: "take-upstream", kind: "content" });
  assert.deepEqual(plan({ status: "DU" }), { action: "take-upstream", kind: "content" });
});

test("add/add is added-broken only when our file no longer compiles", () => {
  assert.deepEqual(plan({ status: "AA", broken: true }), {
    action: "remove-added",
    kind: "added-broken",
  });
  assert.deepEqual(plan({ status: "AA", broken: false }), {
    action: "take-upstream",
    kind: "content",
  });
});

test("the six seam files stay unmerged in a dry run and take upstream with --apply", () => {
  const seam = "apps/server/src/server.ts";
  assert.deepEqual(plan({ status: "UU", path: seam, seam: true }), {
    action: "leave-seam",
    kind: null,
  });
  assert.deepEqual(plan({ status: "UU", path: seam, seam: true, apply: true }), {
    action: "take-upstream",
    kind: null,
  });
});

test("an unknown conflict is reported, never guessed", () => {
  assert.deepEqual(plan({ status: "XY" }), { action: "unclassified", kind: null });
});

test("our added lines count without the file header", () => {
  const patch = [
    "diff --git a/x b/x",
    "--- a/x",
    "+++ b/x",
    "@@ -1 +1,2 @@",
    "-old",
    "+new",
    "+more",
  ].join("\n");
  assert.equal(countPatchLines(patch), 2);
});

test("same content under orchestration-v2 is a relocation", () => {
  const ours = new Map([
    ["apps/server/src/orchestration/A.ts", "h1"],
    ["apps/server/src/orchestration/Other.ts", "h3"],
  ]);
  const result = new Map([
    ["apps/server/src/orchestration-v2/A.ts", "h1"],
    ["apps/server/src/orchestration-v2/B.ts", "h2"],
  ]);
  assert.deepEqual(renamedIntoV2(ours, result), ["apps/server/src/orchestration-v2/A.ts"]);
  assert.deepEqual(
    renamedIntoV2(ours, new Map(result).set("apps/server/src/orchestration-v2/A.ts", "h9")),
    [],
  );
});

test("an import that existed at ours and is gone after the merge is broken", () => {
  const file = "apps/server/src/personal/a.ts";
  const source = 'import { engine } from "../orchestration/Services/OrchestrationEngine.ts";';
  assert.equal(
    hasBrokenImport({
      file,
      source,
      oursFiles: new Set([file, "apps/server/src/orchestration/Services/OrchestrationEngine.ts"]),
      files: new Set([file]),
    }),
    true,
  );
  assert.equal(
    hasBrokenImport({
      file,
      source,
      oursFiles: new Set([file, "apps/server/src/orchestration/Services/OrchestrationEngine.ts"]),
      files: new Set([file, "apps/server/src/orchestration/Services/OrchestrationEngine.ts"]),
    }),
    false,
  );
});

test("a missing asset that never resolved is not a broken import", () => {
  assert.equal(
    hasBrokenImport({
      file: "apps/server/src/personal/a.ts",
      source: 'import data from "./model-manifest.json" with { type: "json" };',
      oursFiles: new Set(["apps/server/src/personal/a.ts"]),
      files: new Set(["apps/server/src/personal/a.ts"]),
    }),
    false,
  );
});

test("target PR falls back to B1 for triage", () => {
  assert.equal(targetPrFor("apps/server/src/personal/a.ts"), "3a");
  assert.equal(targetPrFor("apps/server/src/orchestration-v2/a.ts"), "C1-C3");
  assert.equal(targetPrFor("apps/web/src/a.tsx"), "phase 4");
  assert.equal(targetPrFor("docs/readme.md"), "B1");
});
