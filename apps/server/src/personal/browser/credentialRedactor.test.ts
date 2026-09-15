import { describe, expect, it } from "vite-plus/test";

import { makeCredentialRedactor, REDACTED_CREDENTIAL } from "./credentialRedactor.ts";

const SECRET = "Hunter2 & co";

describe("credential redactor", () => {
  it("changes nothing until a value has been learned", () => {
    const redactor = makeCredentialRedactor();
    const value = { text: SECRET, nested: [SECRET] };
    expect(redactor.redact(value)).toBe(value);
  });

  it("masks the value and the spellings a page or URL turns it into", () => {
    const redactor = makeCredentialRedactor();
    redactor.remember(SECRET);
    const spellings = [
      SECRET,
      SECRET.toUpperCase(),
      encodeURIComponent(SECRET),
      encodeURIComponent(SECRET).replace(/%20/g, "+"),
      "Hunter2 &amp; co",
    ];
    for (const spelling of spellings) {
      const masked = redactor.redactText(`before ${spelling} after`);
      expect(masked).toBe(`before ${REDACTED_CREDENTIAL} after`);
    }
  });

  // An evaluate result is arbitrary JSON; the walk has to reach every string.
  it("masks strings at any depth of an evaluate-shaped result, keys included in arrays", () => {
    const redactor = makeCredentialRedactor();
    redactor.remember(SECRET);
    const result = redactor.redact({
      value: SECRET,
      data: { deep: [{ field: `x${SECRET}y` }] },
      count: 3,
      flag: true,
      none: null,
    });
    expect(JSON.stringify(result)).not.toContain("Hunter2");
    expect(result).toEqual({
      value: REDACTED_CREDENTIAL,
      data: { deep: [{ field: `x${REDACTED_CREDENTIAL}y` }] },
      count: 3,
      flag: true,
      none: null,
    });
  });

  it("passes a screenshot's base64 through untouched but still masks its siblings", () => {
    const redactor = makeCredentialRedactor();
    redactor.remember("aaaa");
    const screenshot = { mimeType: "image/png", data: "aaaaaaaa", width: 1, height: 1 };
    const result = redactor.redact({ title: "aaaa", screenshot });
    expect(result.screenshot).toEqual(screenshot);
    expect(result.title).toBe(REDACTED_CREDENTIAL);
  });

  it("ignores values too short to mask without eating ordinary words", () => {
    const redactor = makeCredentialRedactor();
    redactor.remember("abc");
    expect(redactor.redactText("abc abc")).toBe("abc abc");
  });

  it("treats regex syntax in a password as literal text", () => {
    const redactor = makeCredentialRedactor();
    redactor.remember("a.b*c(d)");
    expect(redactor.redactText("axbbbcd a.b*c(d)")).toBe(`axbbbcd ${REDACTED_CREDENTIAL}`);
  });
});
