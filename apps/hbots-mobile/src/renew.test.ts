import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { classifyFailure, DpopRequiredError } from "./failure";
import { renewSession } from "./renew";
import type { StoredSession } from "./session";

vi.mock("./dpop", () => ({
  createDpopProof: async () => ({ proof: "test-proof", thumbprint: "test-thumbprint" }),
  loadOrCreateDpopKey: async () => ({
    privateJwk: {},
    publicJwk: {},
    thumbprint: "test-thumbprint",
  }),
}));

const SESSION: StoredSession = {
  environmentId: "env-1",
  label: "Laptop",
  httpBaseUrl: "https://relay.example.test/",
  wsBaseUrl: "wss://relay.example.test/",
  accessToken: "old-token",
  scope: "ws",
  expiresAt: 1_000,
  pairedAt: 500,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const tokenBody = (accessToken: string, expiresIn: number) => ({
  access_token: accessToken,
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "Bearer",
  expires_in: expiresIn,
  scope: "ws",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renewSession", () => {
  it("posts the Bearer token and stores the new token with a fresh expiry", async () => {
    const fetchSpy = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      json(200, tokenBody("new-token", 2_592_000)),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const renewed = await renewSession(SESSION, 10_000);

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://relay.example.test/api/auth/session/renew",
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer old-token" });
    expect(renewed.accessToken).toBe("new-token");
    expect(renewed.expiresAt).toBe(10_000 + 2_592_000 * 1000);
    expect(renewed.environmentId).toBe("env-1");
    expect(renewed.pairedAt).toBe(500);
  });

  it("renews a bound session with a DPoP proof for the same key", async () => {
    const fetchSpy = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      json(200, { ...tokenBody("new-token", 2_592_000), token_type: "DPoP" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const renewed = await renewSession({ ...SESSION, authMethod: "dpop" }, 10_000);

    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({
      authorization: "DPoP old-token",
      dpop: "test-proof",
    });
    expect(renewed.accessToken).toBe("new-token");
    expect(renewed.authMethod).toBe("dpop");
  });

  it("refuses a Bearer answer for a bound session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, tokenBody("new-token", 2_592_000))),
    );

    const failure = await renewSession({ ...SESSION, authMethod: "dpop" }, 10_000).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(DpopRequiredError);
  });

  it("keeps the same token when the server says it is not due yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, tokenBody("old-token", 100))),
    );
    const renewed = await renewSession(SESSION, 10_000);
    expect(renewed.accessToken).toBe("old-token");
    expect(renewed.expiresAt).toBe(10_000 + 100_000);
  });

  it("surfaces a 403 session_not_renewable as signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(403, { code: "session_not_renewable" })),
    );
    const failure = await renewSession(SESSION).catch(classifyFailure);
    expect(failure).toEqual({ kind: "authDead", reason: "session-ended" });
  });

  it("surfaces a 401 as signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { code: "auth_invalid" })),
    );
    const failure = await renewSession(SESSION).catch(classifyFailure);
    expect(failure).toEqual({ kind: "authDead", reason: "unauthorized" });
  });

  it("surfaces a Cloudflare page as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>1033</html>", { status: 530 })),
    );
    const failure = await renewSession(SESSION).catch(classifyFailure);
    expect(failure).toEqual({ kind: "unreachable" });
  });
});
