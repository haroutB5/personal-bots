// Fixtures for the pending check. Run:
//   node --test scripts/personal/sync/pending-check.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
const { test } = NodeTest;

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

  NodeAssert.deepEqual(result.outsidePending, ["apps/server/src/personal/new.test.ts"]);
  NodeAssert.deepEqual(result.allowed, [pendingFile]);
});

test("a pending test that passes must leave the list", () => {
  const result = checkPending({
    pending: [pendingFile],
    ...readVitestReport(report([[`/repo/${pendingFile}`, "passed", ["passed"]]])),
  });

  NodeAssert.deepEqual(result.nowPassing, [pendingFile]);
  NodeAssert.deepEqual(result.outsidePending, []);
});

test("a pending test that still fails is allowed and not stale", () => {
  const result = checkPending({
    pending: [pendingFile],
    ...readVitestReport(report([[pendingFile, "failed", ["failed"]]])),
  });

  NodeAssert.deepEqual(result.allowed, [pendingFile]);
  NodeAssert.deepEqual(result.nowPassing, []);
  NodeAssert.deepEqual(result.notRun, []);
});

test("a passing assertion with a failed file status still counts as failed", () => {
  const { failed, passed } = readVitestReport(report([[otherFile, "failed", ["passed"]]]));
  NodeAssert.deepEqual([...failed], [otherFile]);
  NodeAssert.deepEqual([...passed], []);
});

test("pending parsing ignores comments, rejects duplicates and absolute paths", () => {
  const parsed = parsePending(
    ["# allowed", "", pendingFile, "  ", pendingFile, "/abs/path.test.ts"].join("\n"),
  );
  NodeAssert.deepEqual(parsed.files, [pendingFile]);
  NodeAssert.deepEqual(parsed.errors, [
    "line 5: duplicate apps/server/src/personal/known.test.ts",
    "line 6: use a repo-relative path, got /abs/path.test.ts",
  ]);
});
