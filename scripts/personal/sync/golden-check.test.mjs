// Fixtures for the B1 golden rule. Run:
//   node --test scripts/personal/sync/golden-check.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

const { test } = NodeTest;

import { diffGoldens, UPSTREAM_OWNED_TAGS, violations } from "./golden-check.mjs";

const golden = (entries) => ({ version: 1, entries });

const personal = (success) => ({
  tag: "personalBots.list",
  success,
});

test("an added path in a personal method passes", () => {
  const before = golden([personal({ type: "object", properties: { id: {} } })]);
  const after = golden([personal({ type: "object", properties: { id: {}, requiredScope: {} } })]);

  const rows = diffGoldens(before, after);
  NodeAssert.deepEqual(violations(rows), []);
  NodeAssert.deepEqual(
    rows.map((row) => row.kind),
    ["added"],
  );
});

test("a removed path in a personal method fails", () => {
  const before = golden([personal({ properties: { textPreviews: {} } })]);
  const after = golden([personal({ properties: {} })]);

  const failures = violations(diffGoldens(before, after));
  NodeAssert.equal(failures.length, 1);
  NodeAssert.equal(failures[0].kind, "missing");
  NodeAssert.equal(failures[0].path, "personalBots.list/success/properties/textPreviews");
});

test("a changed path in a personal method fails", () => {
  const before = golden([personal({ properties: { mode: { type: "string" } } })]);
  const after = golden([personal({ properties: { mode: { type: "number" } } })]);

  const failures = violations(diffGoldens(before, after));
  NodeAssert.equal(failures.length, 1);
  NodeAssert.equal(failures[0].kind, "changed");
});

test("removing an enum value in a personal method fails, adding one passes", () => {
  const before = golden([personal({ enum: ["read", "write"] })]);
  const added = golden([personal({ enum: ["read", "write", "manage"] })]);
  const removed = golden([personal({ enum: ["read"] })]);

  NodeAssert.deepEqual(violations(diffGoldens(before, added)), []);
  const failures = violations(diffGoldens(before, removed));
  NodeAssert.equal(failures.length, 1);
  NodeAssert.equal(failures[0].kind, "enum");
  NodeAssert.deepEqual(failures[0].removed, ["write"]);
});

test("upstream-owned snapshots may lose paths; other methods may not", () => {
  const before = golden([
    { tag: UPSTREAM_OWNED_TAGS[0], success: { properties: { textPreviews: {} } } },
    { tag: UPSTREAM_OWNED_TAGS[1], payload: { properties: { refreshLatestVersion: {} } } },
    personal({ properties: { textPreviews: {} } }),
  ]);
  const after = golden([
    { tag: UPSTREAM_OWNED_TAGS[0], success: { properties: {} } },
    { tag: UPSTREAM_OWNED_TAGS[1], payload: { properties: {} } },
    personal({ properties: {} }),
  ]);

  const failures = violations(diffGoldens(before, after));
  NodeAssert.equal(failures.length, 1);
  NodeAssert.equal(failures[0].path, "personalBots.list/success/properties/textPreviews");
});

test("a missing or added method follows the same rule", () => {
  const before = golden([personal({ properties: {} })]);
  const after = golden([]);
  const added = golden([personal({ properties: {} }), { tag: "personalBots.new", properties: {} }]);

  NodeAssert.equal(violations(diffGoldens(before, after))[0].kind, "missing-method");
  NodeAssert.deepEqual(violations(diffGoldens(before, added)), []);
});
