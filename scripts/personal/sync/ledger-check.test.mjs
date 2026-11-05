// Fixtures for the ledger check. Run:
//   node --test scripts/personal/sync/ledger-check.test.mjs
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { test } from "node:test";

import { checkLedgerText, LEDGER_HEADER, missingPatches } from "./ledger-check.mjs";

const header = LEDGER_HEADER.join("\t");
const row = (columns) => columns.join("\t");

test("a well-formed ledger passes and keeps its rows", () => {
  const text = [
    header,
    row(["apps/server/src/a.ts", "content", "12", "C2", "open", ""]),
    row(["apps/server/src/b.ts", "modify-delete", "3", "C4", "done", ""]),
  ].join("\n");

  const result = checkLedgerText(text);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].targetPR, "C2");
});

test("a row without a target PR fails by name", () => {
  const text = [header, row(["apps/server/src/a.ts", "content", "12", "", "open", ""])].join("\n");
  assert.deepEqual(checkLedgerText(text).errors, ["line 2: apps/server/src/a.ts has no target PR"]);
});

test("a dropped row needs a reason", () => {
  const text = [header, row(["apps/server/src/a.ts", "content", "0", "C2", "dropped", "  "])].join(
    "\n",
  );
  assert.deepEqual(checkLedgerText(text).errors, [
    "line 2: apps/server/src/a.ts is dropped without a reason",
  ]);
});

test("structural damage is reported per row", () => {
  const text = [
    header,
    row(["apps/server/src/a.ts", "other", "x", "C2", "lost", ""]),
    row(["apps/server/src/a.ts", "content", "1", "C2", "open", ""]),
    "too\tfew\tcolumns",
  ].join("\n");

  const { errors } = checkLedgerText(text);
  assert.ok(
    errors.some((error) => error.includes("kind must be one of")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((error) => error.includes("ourLines must be a non-negative integer")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((error) => error.includes("status must be one of")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((error) => error.includes("duplicate path")),
    errors.join("\n"),
  );
  assert.ok(
    errors.some((error) => error.includes("expected 6 columns, got 3")),
    errors.join("\n"),
  );
});

test("a missing header is rejected", () => {
  assert.deepEqual(checkLedgerText("a.ts\tcontent\t1\tC2\topen\t").errors, [
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
      row(["apps/server/src/a.ts", "content", "1", "C2", "open", ""]),
      row(["apps/server/src/b.ts", "content", "1", "C2", "open", ""]),
    ].join("\n"),
  );

  assert.deepEqual(missingPatches(rows, dir), ["apps/server/src/b.ts"]);
});
