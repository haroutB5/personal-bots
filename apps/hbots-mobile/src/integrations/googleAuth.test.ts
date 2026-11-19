import { describe, expect, it } from "vite-plus/test";

import {
  GMAIL_SCOPES,
  makeGoogleAuthPort,
  parseGoogleAuthResult,
  parseSigningIdentity,
} from "./googleAuth";

describe("parseGoogleAuthResult", () => {
  it("returns the code and the granted scopes", () => {
    expect(
      parseGoogleAuthResult({
        status: "granted",
        serverAuthCode: "4/0c",
        grantedScopes: [...GMAIL_SCOPES],
      }),
    ).toEqual({ status: "granted", serverAuthCode: "4/0c", grantedScopes: [...GMAIL_SCOPES] });
  });

  it("never turns a granted answer without a code into a grant", () => {
    expect(parseGoogleAuthResult({ status: "granted", grantedScopes: [] })).toEqual({
      status: "no_code",
    });
    expect(parseGoogleAuthResult({ status: "granted", serverAuthCode: "" })).toEqual({
      status: "no_code",
    });
  });

  it("names an unticked scope", () => {
    expect(parseGoogleAuthResult({ status: "scopes_denied", missing: ["x"] })).toEqual({
      status: "scopes_denied",
      missing: ["x"],
    });
  });

  it("treats anything unrecognised as an error", () => {
    for (const raw of [null, undefined, "ok", 3, {}, { status: "weird" }]) {
      expect(parseGoogleAuthResult(raw).status).toBe("error");
    }
  });
});

describe("makeGoogleAuthPort", () => {
  it("is unavailable without the native module", async () => {
    const port = makeGoogleAuthPort(null);
    expect(await port.authorize("client")).toEqual({ status: "unavailable" });
    expect(port.signingIdentity()).toBeNull();
  });

  it("asks for the two Gmail scopes with the server client id and parses the answer", async () => {
    const calls: Array<[string, ReadonlyArray<string>]> = [];
    const port = makeGoogleAuthPort({
      authorize: async (id, scopes) => {
        calls.push([id, scopes]);
        return { status: "granted", serverAuthCode: "4/0c", grantedScopes: [...scopes] };
      },
      signingIdentity: () => ({ packageName: "com.haroutb5.hbots", sha1: "AA", sha256: "BB" }),
    });
    expect((await port.authorize("web-client")).status).toBe("granted");
    expect(calls).toEqual([["web-client", [...GMAIL_SCOPES]]]);
    expect(port.signingIdentity()).toEqual({
      packageName: "com.haroutb5.hbots",
      sha1: "AA",
      sha256: "BB",
    });
  });

  it("turns a thrown native error into an error result", async () => {
    const port = makeGoogleAuthPort({
      authorize: async () => {
        throw new Error("E_NO_ACTIVITY");
      },
      signingIdentity: () => null,
    });
    expect(await port.authorize("c")).toMatchObject({ status: "error", message: "E_NO_ACTIVITY" });
  });
});

describe("parseSigningIdentity", () => {
  it("needs all three strings", () => {
    expect(parseSigningIdentity({ packageName: "p", sha1: "a", sha256: "b" })).toEqual({
      packageName: "p",
      sha1: "a",
      sha256: "b",
    });
    expect(parseSigningIdentity({ packageName: "p", sha1: "a" })).toBeNull();
    expect(parseSigningIdentity(null)).toBeNull();
  });
});
