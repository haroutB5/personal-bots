import { describe, expect, it } from "vite-plus/test";

import { checkPastedAddress, minutesLeft, redirectPortOf } from "./signInAddress";

const LINK =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A51121%2Foauth-callback&state=abc";

describe("redirectPortOf", () => {
  it("reads the loopback port out of the sign-in link", () => {
    expect(redirectPortOf(LINK)).toBe("51121");
    expect(redirectPortOf("https://example.com/auth")).toBeNull();
    expect(redirectPortOf(null)).toBeNull();
    expect(redirectPortOf("not a url")).toBeNull();
  });
});

describe("checkPastedAddress (SPEC 6 and 7)", () => {
  it("accepts the address Safari shows with a code, trimmed", () => {
    expect(
      checkPastedAddress("  http://127.0.0.1:51121/oauth-callback?code=4%2F0A&state=abc \n", LINK),
    ).toEqual({
      ok: true,
      address: "http://127.0.0.1:51121/oauth-callback?code=4%2F0A&state=abc",
    });
    expect(checkPastedAddress("http://localhost:51121/cb?code=1", LINK).ok).toBe(true);
  });

  it("says what was pasted when it is the sign-in page, not the address after it", () => {
    const result = checkPastedAddress(LINK, LINK);
    expect(result).toMatchObject({ ok: false, kind: "signInPage" });
    expect(result.ok ? "" : result.message).toBe(
      "That's the sign-in page, not the address Safari shows after it. That one starts with http://127.0.0.1",
    );
    // The wrong port is another flow's listener.
    expect(checkPastedAddress("http://127.0.0.1:9999/cb?code=1", LINK)).toMatchObject({
      ok: false,
      kind: "signInPage",
    });
  });

  it("refuses text that is not an address, or an address with no code", () => {
    expect(checkPastedAddress("4/0AbCdEf", LINK)).toMatchObject({
      ok: false,
      kind: "notAnAddress",
    });
    expect(checkPastedAddress("http://127.0.0.1:51121/oauth-callback", LINK)).toMatchObject({
      ok: false,
      kind: "notAnAddress",
    });
    expect(checkPastedAddress("", LINK).ok).toBe(false);
  });

  it("access_denied is its own answer: Start again", () => {
    expect(
      checkPastedAddress("http://127.0.0.1:51121/oauth-callback?error=access_denied", LINK),
    ).toEqual({
      ok: false,
      kind: "denied",
      message: "Google says you said no. Start again to try once more.",
    });
    // Another error still reaches the server, which knows what to say.
    expect(checkPastedAddress("http://127.0.0.1:51121/cb?error=server_error", LINK).ok).toBe(true);
  });
});

describe("minutesLeft", () => {
  const now = Date.parse("2026-10-20T10:00:00.000Z");
  it("is silent while 10 or more minutes remain, then counts down to 0", () => {
    expect(minutesLeft("2026-10-20T10:12:00.000Z", now)).toBeNull();
    expect(minutesLeft("2026-10-20T10:09:00.000Z", now)).toBe(9);
    expect(minutesLeft("2026-10-20T10:00:30.000Z", now)).toBe(1);
    expect(minutesLeft("2026-10-20T09:59:00.000Z", now)).toBe(0);
    expect(minutesLeft(null, now)).toBeNull();
  });
});
