import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../dpop", () => ({ createDpopProof: vi.fn() }));

import { createDpopProof } from "../dpop";
import { RequestFailure } from "../failure";
import type { StoredSession } from "../session";
import {
  BROWSER_STREAM_PATH,
  DESKTOP_STREAM_PATH,
  liveViewURLs,
  streamSocketUrl,
} from "./liveViewAccess";

const SESSION: StoredSession = {
  environmentId: "env-1",
  label: "Harout's laptop",
  httpBaseUrl: "https://relay.example.test/",
  wsBaseUrl: "wss://relay.example.test/",
  accessToken: "tok-1",
  scope: "ws",
  expiresAt: 1,
  pairedAt: 1,
};

const TICKET = {
  ticket: "ticket-1",
  expiresAt: "2026-11-06T10:05:00.000Z",
};

function ticketFetch() {
  const fetchSpy = vi.fn(
    async (_url: URL | string, _init?: RequestInit) =>
      new Response(JSON.stringify(TICKET), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

const BOUND: StoredSession = { ...SESSION, authMethod: "dpop" };
const TICKET_URL = "https://relay.example.test/api/auth/websocket-ticket";

beforeEach(() => {
  vi.mocked(createDpopProof).mockReset();
  vi.mocked(createDpopProof).mockResolvedValue({
    proof: "proof-1",
    thumbprint: "thumb-1",
  } as Awaited<ReturnType<typeof createDpopProof>>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamSocketUrl", () => {
  it("keeps the relay path prefix on the same host", () => {
    expect(streamSocketUrl(SESSION, BROWSER_STREAM_PATH, "ticket-1")).toBe(
      "wss://relay.example.test/api/personal/browser/stream?wsTicket=ticket-1",
    );
    expect(
      streamSocketUrl(
        { ...SESSION, wsBaseUrl: "wss://relay.example.test/relay/abc/" },
        DESKTOP_STREAM_PATH,
        "ticket-1",
      ),
    ).toBe("wss://relay.example.test/relay/abc/api/personal/desktop/stream?wsTicket=ticket-1");
  });

  it("drops any query the session base carried and adds only the ticket", () => {
    expect(
      streamSocketUrl(
        { ...SESSION, wsBaseUrl: "wss://relay.example.test/relay/abc/?old=1" },
        BROWSER_STREAM_PATH,
        "ticket 2",
      ),
    ).toBe("wss://relay.example.test/relay/abc/api/personal/browser/stream?wsTicket=ticket+2");
  });
});

describe("live view ticket request", () => {
  it("signs a DPoP-bound session with its access token and a proof for the ticket route", async () => {
    const fetchSpy = ticketFetch();

    await liveViewURLs(BOUND);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(TICKET_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "DPoP tok-1", dpop: "proof-1" });
    expect(createDpopProof).toHaveBeenCalledTimes(1);
    expect(createDpopProof).toHaveBeenCalledWith({
      method: "POST",
      url: TICKET_URL,
      accessToken: "tok-1",
    });
  });

  it("keeps a bearer session on the plain bearer header with no proof", async () => {
    const fetchSpy = ticketFetch();

    await liveViewURLs(SESSION);

    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(TICKET_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer tok-1" });
    expect(createDpopProof).not.toHaveBeenCalled();
  });

  it("passes the abort signal through to the request", async () => {
    const fetchSpy = ticketFetch();
    const controller = new AbortController();

    await liveViewURLs(BOUND, controller.signal);

    const [, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a ticket response the contract cannot read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ticket: "" }), { status: 200 })),
    );

    await expect(liveViewURLs(SESSION)).rejects.toBeInstanceOf(Error);
  });

  it("surfaces an HTTP failure as a request failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 401 })),
    );

    const failure = await liveViewURLs(BOUND).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RequestFailure);
    expect((failure as RequestFailure).detail).toEqual({
      kind: "http",
      route: "ticket",
      status: 401,
      jsonBody: false,
    });
  });
});

describe("liveViewURLs", () => {
  it("mints one ticket and gives both sockets that ticket", async () => {
    const fetchSpy = ticketFetch();

    await expect(liveViewURLs(SESSION)).resolves.toEqual({
      browser: "wss://relay.example.test/api/personal/browser/stream?wsTicket=ticket-1",
      desktop: "wss://relay.example.test/api/personal/desktop/stream?wsTicket=ticket-1",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
