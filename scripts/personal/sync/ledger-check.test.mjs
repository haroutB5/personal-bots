// Fixtures for the ledger check. Run:
//   node --test scripts/personal/sync/ledger-check.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
const { test } = NodeTest;

import {
  checkLedgerText,
  landedTargetErrors,
  LEDGER_HEADER,
  missingPatches,
  openAtErrors,
} from "./ledger-check.mjs";

const header = LEDGER_HEADER.join("\t");
const row = (columns) => columns.join("\t");

test("a well-formed ledger passes and keeps its rows", () => {
  const text = [
    header,
    row(["apps/server/src/a.ts", "", "content", "12", "C2", "open", ""]),
    row(["apps/server/src/b.ts", "", "modify-delete", "3", "C4", "done", ""]),
  ].join("\n");

  const result = checkLedgerText(text);
  NodeAssert.deepEqual(result.errors, []);
  NodeAssert.equal(result.rows.length, 2);
  NodeAssert.equal(result.rows[0].targetPR, "C2");
});

test("a renamed row keeps its origin and an empty origin is valid", () => {
  const { rows, errors } = checkLedgerText(
    [
      header,
      row([
        "apps/server/src/provider/ClaudeProvider.ts",
        "apps/server/src/provider/Layers/ClaudeProvider.ts",
        "content",
        "8",
        "C5",
        "open",
        "",
      ]),
      row(["apps/server/src/provider/CodexProvider.ts", "", "content", "2", "C6", "open", ""]),
    ].join("\n"),
  );

  NodeAssert.deepEqual(errors, []);
  NodeAssert.equal(rows[0].origin, "apps/server/src/provider/Layers/ClaudeProvider.ts");
  NodeAssert.equal(rows[1].origin, "");
});

test("a row without a target PR fails by name", () => {
  const text = [header, row(["apps/server/src/a.ts", "", "content", "12", "", "open", ""])].join(
    "\n",
  );
  NodeAssert.deepEqual(checkLedgerText(text).errors, [
    "line 2: apps/server/src/a.ts has no target PR",
  ]);
});

test("a dropped row needs a reason", () => {
  const text = [
    header,
    row(["apps/server/src/a.ts", "", "content", "0", "C2", "dropped", "  "]),
  ].join("\n");
  NodeAssert.deepEqual(checkLedgerText(text).errors, [
    "line 2: apps/server/src/a.ts is dropped without a reason",
  ]);
});

test("structural damage is reported per row", () => {
  const text = [
    header,
    row(["apps/server/src/a.ts", "", "other", "x", "C2", "lost", ""]),
    row(["apps/server/src/a.ts", "", "content", "1", "C2", "open", ""]),
    "too\tfew\tcolumns",
  ].join("\n");

  const { errors } = checkLedgerText(text);
  NodeAssert.ok(
    errors.some((error) => error.includes("kind must be one of")),
    errors.join("\n"),
  );
  NodeAssert.ok(
    errors.some((error) => error.includes("ourLines must be a non-negative integer")),
    errors.join("\n"),
  );
  NodeAssert.ok(
    errors.some((error) => error.includes("status must be one of")),
    errors.join("\n"),
  );
  NodeAssert.ok(
    errors.some((error) => error.includes("duplicate path")),
    errors.join("\n"),
  );
  NodeAssert.ok(
    errors.some((error) => error.includes("expected 7 columns, got 3")),
    errors.join("\n"),
  );
});

test("a missing header is rejected", () => {
  NodeAssert.deepEqual(checkLedgerText("a.ts\t\tcontent\t1\tC2\topen\t").errors, [
    `header must be: ${header}`,
  ]);
});

test("--patches reports exactly the rows without a patch file", () => {
  const dir = NodeFS.mkdtempSync("/tmp/ledger-check-");
  NodeFS.mkdirSync(NodePath.join(dir, "apps/server/src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "apps/server/src/a.ts.patch"), "diff\n");
  const { rows } = checkLedgerText(
    [
      header,
      row(["apps/server/src/a.ts", "", "content", "1", "C2", "open", ""]),
      row(["apps/server/src/b.ts", "", "content", "1", "C2", "open", ""]),
    ].join("\n"),
  );

  NodeAssert.deepEqual(missingPatches(rows, dir), ["apps/server/src/b.ts"]);
});

test("--no-open-at B1 reports a row B1 left open and accepts a closed one", () => {
  const { rows } = checkLedgerText(
    [
      header,
      row(["apps/server/src/a.ts", "", "content", "1", "B1", "open", ""]),
      row(["apps/server/src/b.ts", "", "content", "1", "B1", "dropped", "upstream has it"]),
      row(["apps/server/src/c.ts", "", "content", "1", "B1", "done", ""]),
      row(["apps/server/src/d.ts", "", "content", "1", "C2", "open", ""]),
    ].join("\n"),
  );
  NodeAssert.deepEqual(openAtErrors(rows, "B1"), [
    "line 2: apps/server/src/a.ts is open at B1; a merge row must be closed there",
  ]);
  NodeAssert.deepEqual(openAtErrors(rows, "C2"), [
    "line 5: apps/server/src/d.ts is open at C2; a merge row must be closed there",
  ]);
});

test("a row that targets a landed PR fails, a landed row that closed passes", () => {
  const text = [
    header,
    row(["apps/server/src/a.ts", "", "content", "1", "3a", "open", ""]),
    row(["apps/server/src/b.ts", "", "content", "1", "A10", "done", "landed with A10"]),
  ].join("\n");

  const { rows } = checkLedgerText(text);
  const errors = landedTargetErrors(rows);
  NodeAssert.equal(errors.length, 2);
  NodeAssert.match(errors[0], /targets 3a, which already landed/);
  NodeAssert.match(errors[1], /targets A10, which already landed/);
});

test("a later PR target, including a combined one, passes the landed rule", () => {
  const text = [
    header,
    row(["apps/server/src/a.ts", "", "content", "1", "C14", "open", ""]),
    row(["apps/server/src/b.ts", "", "content", "1", "C4+C10", "open", ""]),
    row(["apps/server/src/c.ts", "", "content", "1", "phase 4", "open", ""]),
  ].join("\n");

  const { rows } = checkLedgerText(text);
  NodeAssert.deepEqual(landedTargetErrors(rows), []);
});
