import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AuthPhoneClientScopes } from "@t3tools/contracts";

import { classifyFailure, DpopRequiredError } from "./failure";
import { failureFor } from "./onboarding/model";
import { decodeTicket, openSocketUrl, pair } from "./pairing";
import type { StoredSession } from "./session";

vi.mock("./dpop", () => ({
  createDpopProof: async () => ({ proof: "test-proof", thumbprint: "test-thumbprint" }),
  loadOrCreateDpopKey: async () => ({
    privateJwk: {},
    publicJwk: {},
    thumbprint: "test-thumbprint",
  }),
}));

const BASE = "https://relay.example.test/";

const DESCRIPTOR = {
  environmentId: "env-1",
  label: "Harout's laptop",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.42",
  capabilities: { repositoryIdentity: true },
};

const TOKEN = {
  access_token: "tok-1",
  issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  token_type: "DPoP",
  expires_in: 2_592_000,
  scope: "ws",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function routeFetch(routes: Record<string, () => Response>) {
  const fetchSpy = vi.fn(async (url: URL | string, _init?: RequestInit) => {
    const handler = routes[new URL(String(url)).pathname];
    if (handler === undefined) {
      throw new Error(`unexpected request ${String(url)}`);
    }
    return handler();
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

const STORED: StoredSession = {
  environmentId: "env-1",
  label: "Harout's laptop",
  httpBaseUrl: BASE,
  wsBaseUrl: "wss://relay.example.test/",
  accessToken: "tok-1",
  scope: "ws",
  expiresAt: 1,
  pairedAt: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("decodeTicket", () => {
  it("accepts the ticket response the server sends, expiresAt included as an ISO string", () => {
    const wire = JSON.parse(
      '{"ticket":"abc123","expiresAt":"2026-11-01T16:40:00.000Z"}',
    ) as unknown;
    expect(decodeTicket(wire).ticket).toBe("abc123");
  });

  it("rejects an empty ticket", () => {
    expect(() => decodeTicket({ ticket: "  ", expiresAt: "2026-11-01T16:40:00.000Z" })).toThrow();
  });
});

describe("pair", () => {
  it("sends the phone proof and device label, then stores a bound session", async () => {
    const fetchSpy = routeFetch({
      "/.well-known/t3/environment": () => json(200, DESCRIPTOR),
      "/oauth/token": () => json(200, TOKEN),
    });
    const session = await pair(
      {
        httpBaseUrl: BASE,
        wsBaseUrl: "wss://relay.example.test/",
        credential: "one-time",
      },
      "Find X9 Pro",
    );
    expect(session).toMatchObject({
      environmentId: "env-1",
      label: "Harout's laptop",
      deviceLabel: "Find X9 Pro",
      accessToken: "tok-1",
      authMethod: "dpop",
      httpBaseUrl: BASE,
    });
    const exchange = fetchSpy.mock.calls.find(([target]) =>
      String(target).endsWith("/oauth/token"),
    );
    expect(exchange?.[1]?.headers).toMatchObject({ dpop: "test-proof" });
    const exchangeBody = new URLSearchParams(String(exchange?.[1]?.body));
    expect(exchangeBody.get("client_label")).toBe("Find X9 Pro");
    expect(exchangeBody.get("client_device_type")).toBe("mobile");
    expect(exchangeBody.get("scope")).toBe(AuthPhoneClientScopes.join(" "));
  });

  it("refuses a Bearer answer and revokes that session", async () => {
    const fetchSpy = routeFetch({
      "/.well-known/t3/environment": () => json(200, DESCRIPTOR),
      "/oauth/token": () => json(200, { ...TOKEN, token_type: "Bearer" }),
      "/api/auth/session/revoke": () => json(200, { revoked: true }),
    });
    const failure = await pair(
      {
        httpBaseUrl: BASE,
        wsBaseUrl: "wss://relay.example.test/",
        credential: "one-time",
      },
      "Find X9 Pro",
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(DpopRequiredError);
    expect(failureFor(failure)).toBe("not-secure");

    const revoke = fetchSpy.mock.calls.find(([target]) =>
      String(target).endsWith("/api/auth/session/revoke"),
    );
    expect(revoke?.[1]?.method).toBe("POST");
    expect(revoke?.[1]?.headers).toMatchObject({ authorization: "Bearer tok-1" });
  });

  it("reports a spent link as signed out", async () => {
    routeFetch({
      "/.well-known/t3/environment": () => json(200, DESCRIPTOR),
      "/oauth/token": () => json(401, { code: "auth_invalid" }),
    });
    const failure = await pair(
      {
        httpBaseUrl: BASE,
        wsBaseUrl: "wss://relay.example.test/",
        credential: "spent",
      },
      "Find X9 Pro",
    ).catch(classifyFailure);
    expect(failure).toEqual({ kind: "authDead", reason: "unauthorized" });
  });
});

describe("openSocketUrl", () => {
  const TICKET = { ticket: "tkt-1", expiresAt: "2026-11-01T16:40:00.000Z" };

  it("mints a fresh ticket on every call", async () => {
    const fetchSpy = routeFetch({
      "/.well-known/t3/environment": () => json(200, DESCRIPTOR),
      "/api/auth/websocket-ticket": () => json(200, TICKET),
    });
    const url = new URL(await openSocketUrl(STORED, "1.66.113"));
    await openSocketUrl(STORED, "1.66.113");
    expect(url.origin).toBe("wss://relay.example.test");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("wsTicket")).toBe("tkt-1");
    const ticketCalls = fetchSpy.mock.calls.filter(([target]) =>
      String(target).endsWith("/api/auth/websocket-ticket"),
    );
    expect(ticketCalls).toHaveLength(2);
  });

  it("signs out when the address now belongs to a different server", async () => {
    routeFetch({
      "/.well-known/t3/environment": () => json(200, { ...DESCRIPTOR, environmentId: "env-2" }),
    });
    const failure = await openSocketUrl(STORED, "1.66.113").catch(classifyFailure);
    expect(failure).toEqual({ kind: "authDead", reason: "environment-mismatch" });
  });

  it("keeps the link when the descriptor is a Cloudflare error page", async () => {
    routeFetch({
      "/.well-known/t3/environment": () => new Response("<html>1033</html>", { status: 530 }),
    });
    const failure = await openSocketUrl(STORED, "1.66.113").catch(classifyFailure);
    expect(failure).toEqual({ kind: "unreachable" });
  });
});
