// node --test scripts/personal/e2e/page-errors.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { ALLOWED_PAGE_ERRORS, describePageErrors, splitPageErrors } from "./page-errors.mjs";

NodeTest.test("the shipped allowlist is well formed (anchored pattern and a reason)", () => {
  for (const entry of ALLOWED_PAGE_ERRORS) {
    NodeAssert.ok(entry.pattern instanceof RegExp);
    NodeAssert.ok(entry.pattern.source.startsWith("^") && entry.pattern.source.endsWith("$"));
    NodeAssert.ok(typeof entry.why === "string" && entry.why.length > 10);
  }
});

NodeTest.test("an empty allowlist lets nothing through", () => {
  const { unexpected, allowed } = splitPageErrors(["Error: boom"], []);
  NodeAssert.deepEqual(unexpected, ["Error: boom"]);
  NodeAssert.deepEqual(allowed, []);
});

NodeTest.test("an exact entry allows only that message", () => {
  const list = [{ pattern: /^Error: known noise$/, why: "test entry for the unit test" }];
  const { unexpected, allowed } = splitPageErrors(
    ["Error: known noise", "Error: known noise plus a real problem"],
    list,
  );
  NodeAssert.deepEqual(allowed, ["Error: known noise"]);
  NodeAssert.deepEqual(unexpected, ["Error: known noise plus a real problem"]);
});

NodeTest.test("the failure line names the journey and the error", () => {
  const line = describePageErrors("chats-search", ["TypeError: x is undefined"]);
  NodeAssert.match(line, /journey "chats-search"/);
  NodeAssert.match(line, /TypeError: x is undefined/);
});

NodeTest.test(
  "the one shipped entry allows the Clerk load error exactly and nothing near it",
  () => {
    const clerk =
      "e: Clerk: Failed to load Clerk JS, failed to load script: https://clerk.t3.codes/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
    const { unexpected, allowed } = splitPageErrors([
      clerk,
      `${clerk} (and more)`,
      "e: Clerk: other",
    ]);
    NodeAssert.deepEqual(allowed, [clerk]);
    NodeAssert.equal(unexpected.length, 2);
  },
);
