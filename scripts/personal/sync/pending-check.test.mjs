// Fixtures for the pending check. Run:
//   node --test scripts/personal/sync/pending-check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkPending, parsePending, readVitestReport } from "./pending-check.mjs";

const pendingFile = "apps/server/src/personal/known.test.ts";
const otherFile = "apps/server/src/personal/other.test.ts";

const report = (results) => ({
  testResults: results.map(([name, status, assertionStatuses = []]) => ({
    name,
    status,
    assertionResults: assertionStatuses.map((statusValue) => ({ status: statusValue })),
  })),
});

test("a failure outside the pending list fails the check by name", () => {
  const result = checkPending({
    pending: [pendingFile],
    ...readVitestReport(
      report([
        ["/repo/apps/server/src/personal/new.test.ts", "failed", ["failed"]],
        [`/repo/${pendingFile}`, "failed", ["failed"]],
      ]),
    ),
  });

  assert.deepEqual(result.outsidePending, ["apps/server/src/personal/new.test.ts"]);
  assert.deepEqual(result.allowed, [pendingFile]);
});

test("a pending test that passes must leave the list", () => {
  const result = checkPending({
    pending: [pendingFile],
    ...readVitestReport(report([[`/repo/${pendingFile}`, "passed", ["passed"]]])),
  });

  assert.deepEqual(result.nowPassing, [pendingFile]);
  assert.deepEqual(result.outsidePending, []);
});

test("a pending test that still fails is allowed and not stale", () => {
  const result = checkPending({
    pending: [pendingFile],
    ...readVitestReport(report([[pendingFile, "failed", ["failed"]]])),
  });

  assert.deepEqual(result.allowed, [pendingFile]);
  assert.deepEqual(result.nowPassing, []);
  assert.deepEqual(result.notRun, []);
});

test("a passing assertion with a failed file status still counts as failed", () => {
  const { failed, passed } = readVitestReport(report([[otherFile, "failed", ["passed"]]]));
  assert.deepEqual([...failed], [otherFile]);
  assert.deepEqual([...passed], []);
});

test("pending parsing ignores comments, rejects duplicates and absolute paths", () => {
  const parsed = parsePending(
    ["# allowed", "", pendingFile, "  ", pendingFile, "/abs/path.test.ts"].join("\n"),
  );
  assert.deepEqual(parsed.files, [pendingFile]);
  assert.deepEqual(parsed.errors, [
    "line 5: duplicate apps/server/src/personal/known.test.ts",
    "line 6: use a repo-relative path, got /abs/path.test.ts",
  ]);
});
