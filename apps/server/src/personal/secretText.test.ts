import { afterEach, describe, expect, it } from "@effect/vitest";

import { secretRedactor } from "./secrets/secretRedaction.ts";
import { looksLikeSecret, redactSecrets } from "./secretText.ts";
import { evidenceFromText } from "./tasks/workRecord.ts";

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

  it("lenient mode lets a 40-hex commit id through everywhere", () => {
    expect(looksLikeSecret(`commit ${SHA1}`, { lenient: true })).toBe(false);
    expect(redactSecrets(`commit ${SHA1}`, { lenient: true })).toBe(`commit ${SHA1}`);
  });

  it("lenient mode keeps a bare 64-hex token as a key, and lets one through only inside a link or a path", () => {
    // 32-byte HMAC and webhook secrets are 64 hex characters.
    expect(looksLikeSecret(`webhook secret ${SHA256}`, { lenient: true })).toBe(true);
    expect(redactSecrets(`digest ${SHA256}`, { lenient: true })).toBe("digest [redacted]");
    expect(looksLikeSecret(`secret=${SHA256}`, { lenient: true })).toBe(true);
    // Inside a link.
    const link = `https://registry.example/v2/blobs/sha256:${SHA256}`;
    expect(looksLikeSecret(`see ${link}`, { lenient: true })).toBe(false);
    // As a part of a path.
    const path = `C:/Users/Ht/.cache/store/${SHA256}/index.json`;
    expect(looksLikeSecret(`file ${path}`, { lenient: true })).toBe(false);
    expect(redactSecrets(`file ${path}`, { lenient: true })).toBe(`file ${path}`);
    // A path of two parts is not enough to call it a path.
    expect(looksLikeSecret(`a/${SHA256}`, { lenient: true })).toBe(true);
    // Strict mode is unchanged.
    expect(looksLikeSecret(link)).toBe(true);
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

  describe("a link that carries a secret", () => {
    // Made of parts: a whole literal reads as a real webhook to a secret scanner.
    const link = (...parts: ReadonlyArray<string>) => parts.join("");
    const SLACK = link(
      "https://hooks.",
      "slack.com/services/",
      "T0123ABCD/",
      "B0456EFGH/",
      "xYzAbCdEfGhIjKlMnOpQrStU",
    );
    const DISCORD = link(
      "https://disc",
      "ord.com/api/web",
      "hooks/1122334455667788/",
      "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    );
    const TEAMS =
      "https://contoso.webhook.office.com/webhookb2/aaaa-bbbb@cccc/IncomingWebhook/dddd/eeee";
    const OUTLOOK = "https://outlook.office.com/webhook/aaaa-bbbb@cccc/IncomingWebhook/dddd/eeee";
    const ZAPIER = "https://hooks.zapier.com/hooks/catch/123456/abcdef/";
    const TELEGRAM = link(
      "https://api.tele",
      "gram.org/bot",
      "123456789:",
      "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
      "/sendMessage",
    );
    const IFTTT = "https://maker.ifttt.com/trigger/door/with/key/dXyZ1234";
    const MATTERMOST = "https://chat.example.com/hooks/abcdefghijklmnopqrstuvwxyz";
    const LOGIC =
      "https://prod-12.westeurope.logic.azure.com:443/workflows/abc123/triggers/manual/paths/invoke?api-version=2016-06-01";
    const KEYS = [
      "https://maps.example.com/api?key=AbCd1234EfGh",
      "https://files.example.com/a.zip?sig=Zm9vYmFyYmF6",
      "https://store.example.net/blob?sv=2024&signature=abcdef123456",
      "https://api.example.com/v1/items?auth=Bearer123456",
      "https://api.example.com/v1/items?secret=hunter2hunter2",
      "https://app.example.com/cb#access_token=abc123def456&state=x",
      "https://user:hunter2@git.example.com/repo.git",
      "https://ghtoken1234567890abcdef@git.example.com/repo.git",
    ];

    it("is a secret in both modes, whatever its length", () => {
      for (const link of [
        SLACK,
        DISCORD,
        TEAMS,
        OUTLOOK,
        ZAPIER,
        TELEGRAM,
        IFTTT,
        MATTERMOST,
        LOGIC,
        ...KEYS,
      ]) {
        expect(looksLikeSecret(`see ${link}`, { lenient: true }), link).toBe(true);
        expect(looksLikeSecret(`see ${link}`), link).toBe(true);
      }
    });

    it("is redacted whole, and the words around it stay", () => {
      for (const link of [SLACK, DISCORD, TEAMS, ZAPIER, TELEGRAM, MATTERMOST, ...KEYS]) {
        const out = redactSecrets(`Post to ${link} when done.`, { lenient: true });
        expect(out, link).toBe("Post to [redacted] when done.");
      }
      expect(redactSecrets(`${SLACK} and ${BLOB}`, { lenient: true })).toBe(
        `[redacted] and ${BLOB}`,
      );
    });

    it("is not saved as evidence, but an ordinary link is", () => {
      expect(
        evidenceFromText(`Posted to ${SLACK}. Change: ${BLOB}`).map((item) => item.ref),
      ).toEqual([BLOB]);
    });

    it("an ordinary link, and a switch that happens to be called auth, stay as they are", () => {
      for (const link of [
        BLOB,
        "https://example.com/docs?page=2&key=",
        "https://example.com/search?q=hooks&author=jo&keyword=slack&auth=1",
        "https://github.com/haroutB5/personal-bots/pull/9",
        "https://discord.com/channels/123/456",
        "https://api.telegram.org/",
      ]) {
        expect(looksLikeSecret(`see ${link}`, { lenient: true }), link).toBe(false);
        expect(redactSecrets(`see ${link}`, { lenient: true }), link).toBe(`see ${link}`);
      }
    });
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

describe("a key the owner saved", () => {
  afterEach(() => secretRedactor.clear());

  it("is a secret whatever it looks like, so memory and records refuse it", () => {
    const plain = "just-some-words-here";
    expect(looksLikeSecret(`remember ${plain}`)).toBe(false);
    secretRedactor.set("ODD_KEY", plain);
    expect(looksLikeSecret(`remember ${plain}`)).toBe(true);
    expect(redactSecrets(`remember ${plain}`)).toBe("remember [secret ODD_KEY]");
    secretRedactor.clear();
    expect(looksLikeSecret(`remember ${plain}`)).toBe(false);
  });
});
