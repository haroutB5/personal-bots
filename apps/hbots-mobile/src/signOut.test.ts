import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { StoredSession } from "./session";
import { describeSignOut, revokeRemoteSession } from "./signOut";

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
  accessToken: "tok",
  scope: "ws",
  expiresAt: 1_000,
  pairedAt: 500,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revokeRemoteSession", () => {
  it("calls the revoke route with the Bearer token and reports a revoke", async () => {
    const fetchSpy = vi.fn(async (_url: URL | string, _init?: RequestInit) =>
      json(200, { revoked: true }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await expect(revokeRemoteSession(SESSION)).resolves.toBe("revoked");
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "https://relay.example.test/api/auth/session/revoke",
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({ authorization: "Bearer tok" });
  });

  it("treats a 404 as a server that is too old", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
    await expect(revokeRemoteSession(SESSION)).resolves.toBe("server-too-old");
  });

  it("treats a 401 as already signed out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { code: "auth_invalid" })),
    );
    await expect(revokeRemoteSession(SESSION)).resolves.toBe("already-signed-out");
  });

  it("reports an unreachable laptop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network request failed");
      }),
    );
    await expect(revokeRemoteSession(SESSION)).resolves.toBe("unreachable");
  });

  it("explains each outcome without leaving the user stranded", () => {
    expect(describeSignOut("revoked")).toContain("removed from your laptop");
    expect(describeSignOut("server-too-old")).toContain("Settings > Connections");
    expect(describeSignOut("unreachable")).toContain("30 days");
  });
});
