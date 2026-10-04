import { describe, expect, it } from "@effect/vitest";

import { looksLikeSecret, redactSecrets } from "./secretText.ts";

const SHA1 = "a1d6a63cde9e4f0b8c7d2e1f3a4b5c6d7e8f9a0b";
const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BLOB = `https://github.com/haroutB5/personal-bots/blob/${SHA1}/apps/server/src/personal/secretText.ts`;
const KEY = "Zk3Jd9Qw2Lm8Xv5Tn1Bc7Rp4Hs6Ye0Ua9Gf2Di3Kj8Ox";

describe("the long-token rule", () => {
  it("is strict by default: a commit id reads as a key (memory keeps it out)", () => {
    expect(looksLikeSecret(`commit ${SHA1}`)).toBe(true);
    expect(looksLikeSecret(`digest ${SHA256}`)).toBe(true);
    expect(looksLikeSecret(BLOB)).toBe(true);
    expect(redactSecrets(`commit ${SHA1}`)).toBe("commit [redacted]");
  });

  it("lenient mode lets pure hex ids of 40 and 64 characters through", () => {
    expect(looksLikeSecret(`commit ${SHA1}`, { lenient: true })).toBe(false);
    expect(looksLikeSecret(`digest ${SHA256}`, { lenient: true })).toBe(false);
    expect(redactSecrets(`commit ${SHA1}`, { lenient: true })).toBe(`commit ${SHA1}`);
  });

  it("lenient mode lets anything inside an https link through, and paths with many short parts", () => {
    expect(looksLikeSecret(BLOB, { lenient: true })).toBe(false);
    expect(redactSecrets(`see ${BLOB} now`, { lenient: true })).toBe(`see ${BLOB} now`);
    expect(
      looksLikeSecret(
        "C:/Claude/AI/_wt/hbots-memscope/apps/server/src/personal/tasks/workRecord2.ts",
        {
          lenient: true,
        },
      ),
    ).toBe(false);
  });

  it("lenient mode still catches a key, a hex run with other letters, and one slash of base64", () => {
    expect(looksLikeSecret(`key ${KEY}`, { lenient: true })).toBe(true);
    expect(redactSecrets(`key ${KEY} end`, { lenient: true })).toBe("key [redacted] end");
    // 41 hex characters is not a commit id, and a longer run mixing letters is not hex only.
    expect(looksLikeSecret(`x ${SHA1}a1`, { lenient: true })).toBe(true);
    expect(looksLikeSecret(`x ${SHA1}zz9`, { lenient: true })).toBe(true);
    // Base64 with one slash is a key, not a path.
    expect(looksLikeSecret(`${KEY.slice(0, 20)}/${KEY.slice(20)}`, { lenient: true })).toBe(true);
    // A key beside a link is not saved by the link.
    expect(looksLikeSecret(`${BLOB} and ${KEY}`, { lenient: true })).toBe(true);
  });

  it("lenient mode keeps the named formats", () => {
    for (const text of [
      "token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "sk-live-abcdefghijklmnop1234",
      "password: hunter2hunter2",
      `${BLOB}?token=ghp_abcdefghijklmnopqrstuvwxyz0123`,
    ]) {
      expect(looksLikeSecret(text, { lenient: true })).toBe(true);
    }
  });
});
