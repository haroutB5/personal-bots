// Fixtures for the B1 resolver rules. Run:
//   node --test scripts/personal/sync/v2-merge-resolve.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backportMatches,
  countPatchLines,
  followSourceTarget,
  hasBrokenImport,
  isV1StubPatch,
  parseRegistryText,
  planFor,
  renamedIntoV2,
  SEAM_FILES,
  targetFor,
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

test("the nine seam files stay unmerged in a dry run and take upstream with --apply", () => {
  assert.equal(SEAM_FILES.length, 9);
  assert.ok(SEAM_FILES.includes("apps/server/src/auth/RpcAuthorization.ts"));
  assert.ok(SEAM_FILES.includes("apps/server/src/mcp/McpHttpServer.ts"));
  assert.ok(SEAM_FILES.includes("apps/server/src/mcp/McpInvocationContext.ts"));
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

test("the DeepSeek area is tested before the generic provider area", () => {
  assert.equal(targetPrFor("packages/provider-deepseek/src/x.ts"), "D1-D7");
  assert.equal(targetPrFor("packages/provider-pi/src/x.ts"), "C5-C9");
});

const registry = () =>
  parseRegistryText(
    [
      "path\ttarget\tstatusAfterB1\trule\tflag\treason",
      "apps/server/src/provider/Services/ProviderCommandReactor.ts\tC4+C10\topen\tregistry\tpersona\tone call",
      "apps/server/src/provider/deepseek/adapter.ts\tD1\tdropped\tregistry\t\tupstreamed",
      "apps/server/src/provider/noop.ts\tB1\tdone\tunion\t\tkeep both key sets",
    ].join("\n"),
  );

test("the registry parses and rejects a duplicate path", () => {
  assert.equal(registry().size, 3);
  assert.throws(() =>
    parseRegistryText(
      [
        "path\ttarget\tstatusAfterB1\trule\tflag\treason",
        "a\tB1\tdone\tunion\t\tx",
        "a\tB1\tdone\tunion\t\tx",
      ].join("\n"),
    ),
  );
});

test("rule 1: a backport is every subject with an upstream PR number", () => {
  const upstream = new Set(["fix(cloud): keep a token (#25301)"]);
  assert.equal(backportMatches(["fix(cloud): keep a token (#25301)"], upstream), true);
  assert.equal(backportMatches([], upstream), false);
  assert.equal(backportMatches(["local fix"], upstream), false);
  assert.equal(backportMatches(["fix(cloud): keep a token (#25301)", "local"], upstream), false);
});

test("rule 2: the registry wins before any area rule", () => {
  const assignment = targetFor({
    path: "apps/server/src/provider/deepseek/adapter.ts",
    patch: null,
    registry: registry(),
    backport: false,
  });
  assert.deepEqual(assignment, {
    target: "D1",
    status: "dropped",
    rule: "registry",
    flag: "",
    reason: "upstreamed",
  });
});

test("rule 3: a test whose added lines only stub v1 services is dropped", () => {
  const patch = [
    "--- a/x.test.ts",
    "+++ b/x.test.ts",
    "@@ -1 +1,4 @@",
    "+  const repo = Layer.provideMerge(ProjectionThreadMessageRepository);",
    "+  // v1 service stand-in",
    "+  getPendingInputActivities: () => Effect.void,",
    "+});",
  ].join("\n");
  assert.equal(isV1StubPatch({ path: "apps/server/src/x.test.ts", patch }), true);
  assert.equal(isV1StubPatch({ path: "apps/server/src/x.ts", patch }), false);
  assert.equal(
    isV1StubPatch({
      path: "apps/server/src/x.test.ts",
      patch: ["+  expect(turn).toEqual({ status: 'running' });"].join("\n"),
    }),
    false,
  );
});

test("rule 4: a test takes the target of the source it names", () => {
  const entries = parseRegistryText(
    [
      "path\ttarget\tstatusAfterB1\trule\tflag\treason",
      "apps/server/src/orchestration/decider.ts\tC1\topen\tregistry\t\tdeleted guard",
      "apps/server/src/usage/usageScanCache.ts\tC14\topen\tregistry\t\treset window",
    ].join("\n"),
  );
  assert.equal(
    followSourceTarget("apps/server/src/orchestration/decider.delete.test.ts", entries)?.target,
    "C1",
  );
  assert.equal(
    followSourceTarget("apps/server/test/usageScanCache.test.ts", entries)?.target,
    "C14",
  );
});

test("rule 5: an unregistered path falls to its area", () => {
  const assignment = targetFor({
    path: "apps/server/src/provider/other.ts",
    patch: null,
    registry: new Map(),
    backport: false,
  });
  assert.deepEqual(assignment, {
    target: "C5-C9",
    status: "open",
    rule: "area",
    flag: "",
    reason: "area C5-C9",
  });
});

test("rule 6: no match is null, never B1 open", () => {
  assert.equal(
    targetFor({ path: "docs/readme.md", patch: null, registry: new Map(), backport: false }),
    null,
  );
});
