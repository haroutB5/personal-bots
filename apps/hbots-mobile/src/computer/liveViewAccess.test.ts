import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../dpop", () => ({ createDpopProof: vi.fn() }));

import { RequestFailure } from "../failure";
import type { StoredSession } from "../session";
import {
  BROWSER_STREAM_PATH,
  DESKTOP_STREAM_PATH,
  liveViewURLs,
  mintStreamTicket,
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

describe("mintStreamTicket", () => {
  it("posts the session bearer to the websocket-ticket route and returns its ticket", async () => {
    const fetchSpy = ticketFetch();

    await expect(mintStreamTicket(SESSION)).resolves.toBe("ticket-1");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://relay.example.test/api/auth/websocket-ticket");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ authorization: "Bearer tok-1" });
  });

  it("rejects a ticket response the contract cannot read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ticket: "" }), { status: 200 })),
    );

    await expect(mintStreamTicket(SESSION)).rejects.toBeInstanceOf(Error);
  });

  it("surfaces an HTTP failure as a request failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 401 })),
    );

    const failure = await mintStreamTicket(SESSION).catch((error: unknown) => error);
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
