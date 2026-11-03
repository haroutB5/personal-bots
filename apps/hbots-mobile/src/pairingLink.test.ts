import { describe, expect, it } from "vite-plus/test";

import { describePairingLinkError, parsePairingLink } from "./pairingLink";

describe("parsePairingLink", () => {
  it("reads the token from the fragment and derives both base urls", () => {
    expect(parsePairingLink("  https://hbots.example.net:8443/pair#token=abc123  ")).toEqual({
      ok: true,
      target: {
        httpBaseUrl: "https://hbots.example.net:8443/",
        wsBaseUrl: "wss://hbots.example.net:8443/",
        credential: "abc123",
      },
    });
  });

  it("falls back to a token query parameter", () => {
    const result = parsePairingLink("https://hbots.example.net/pair?token=q1");
    expect(result.ok && result.target.credential).toBe("q1");
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["not a link", "not-a-url"],
    ["http://10.0.2.2:38472/pair#token=abc", "not-https"],
    ["https://hbots.example.net/pair", "no-token"],
    ["https://hbots.example.net/pair#token=", "no-token"],
  ] as const)("rejects %j as %s", (raw, error) => {
    expect(parsePairingLink(raw)).toEqual({ ok: false, error });
  });

  it("tells the user why an http link is refused", () => {
    expect(describePairingLinkError("not-https")).toBe(
      "hbots only connects over https. Use the https address of your server.",
    );
  });
});
