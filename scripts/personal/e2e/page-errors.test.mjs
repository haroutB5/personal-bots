// node --test scripts/personal/e2e/page-errors.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED_PAGE_ERRORS, describePageErrors, splitPageErrors } from "./page-errors.mjs";

test("the shipped allowlist is well formed (anchored pattern and a reason)", () => {
  for (const entry of ALLOWED_PAGE_ERRORS) {
    assert.ok(entry.pattern instanceof RegExp);
    assert.ok(entry.pattern.source.startsWith("^") && entry.pattern.source.endsWith("$"));
    assert.ok(typeof entry.why === "string" && entry.why.length > 10);
  }
});

test("an empty allowlist lets nothing through", () => {
  const { unexpected, allowed } = splitPageErrors(["Error: boom"], []);
  assert.deepEqual(unexpected, ["Error: boom"]);
  assert.deepEqual(allowed, []);
});

test("an exact entry allows only that message", () => {
  const list = [{ pattern: /^Error: known noise$/, why: "test entry for the unit test" }];
  const { unexpected, allowed } = splitPageErrors(
    ["Error: known noise", "Error: known noise plus a real problem"],
    list,
  );
  assert.deepEqual(allowed, ["Error: known noise"]);
  assert.deepEqual(unexpected, ["Error: known noise plus a real problem"]);
});

test("the failure line names the journey and the error", () => {
  const line = describePageErrors("chats-search", ["TypeError: x is undefined"]);
  assert.match(line, /journey "chats-search"/);
  assert.match(line, /TypeError: x is undefined/);
});

test("the one shipped entry allows the Clerk load error exactly and nothing near it", () => {
  const clerk =
    "e: Clerk: Failed to load Clerk JS, failed to load script: https://clerk.t3.codes/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
  const { unexpected, allowed } = splitPageErrors([clerk, `${clerk} (and more)`, "e: Clerk: other"]);
  assert.deepEqual(allowed, [clerk]);
  assert.equal(unexpected.length, 2);
});
