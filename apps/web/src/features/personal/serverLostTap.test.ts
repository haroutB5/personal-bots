import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { findLostTap, SHOWN_CACHE, SHOWN_KEY } from "./lostNotificationTaps";
import { createNotificationTapController, LOST_TAP_GRACE_MS } from "./notificationTap";
import {
  askServerForLostTap,
  currentPushEndpoint,
  decideServerLostTap,
  type EndpointMemory,
  makeLostTapFinder,
  PUSH_SENT_URL,
} from "./serverLostTap";

const IPHONE = "https://web.push.apple.com/QGuYx-iphone";
const LAPTOP = "https://fcm.googleapis.com/fcm/send/laptop";
const ASSISTANT_CHAT = "/bots/personal-seed-assistant/0c4b1d06-0852-4d28-8904-6ca40ac017e8";
const CTO_CHAT = "/bots/969c2998-6725-4bf1-8c48-df9a6c75d46c/a6a6a26e-7fb3-4768-a868-cf6f27712717";
const LOOKBACK_MS = 2 * 60_000;

/**
 * The server's outbox as the route answers from it (sentPushesRoute.ts):
 * pushes sent to the asking device since it went away, at most two minutes.
 */
function fakeServer() {
  const sent: Array<{ endpoint: string; url: string; at: number }> = [];
  const requests: Array<{ endpoint: string; awayMs: number | null }> = [];
  let status = 200;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(PUSH_SENT_URL);
    expect(init?.credentials).toBe("same-origin");
    const body = JSON.parse(String(init?.body)) as { endpoint: string; awayMs: number | null };
    requests.push(body);
    if (status !== 200) return new Response("", { status });
    const known = [IPHONE, LAPTOP].includes(body.endpoint);
    const back = body.awayMs === null ? LOOKBACK_MS : Math.min(body.awayMs, LOOKBACK_MS);
    const from = Date.now() - back;
    const pushes = known
      ? sent
          .filter((push) => push.endpoint === body.endpoint && push.at >= from)
          .map((push) => ({ url: push.url, sentAt: new Date(push.at).toISOString() }))
      : [];
    return Response.json({ known, pushes });
  });
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    send: (endpoint: string, url: string) => sent.push({ endpoint, url, at: Date.now() }),
    fail: (code: number) => {
      status = code;
    },
  };
}

/** Cache Storage holding the phone's own list, or nothing (as on an iOS resume). */
function phoneCaches(entries: Array<{ key: string; url: string; at: number }> = []) {
  const body = JSON.stringify(entries);
  vi.stubGlobal("caches", {
    open: async (name: string) => ({
      match: async (key: string) =>
        name === SHOWN_CACHE && key === SHOWN_KEY && entries.length > 0
          ? new Response(body)
          : undefined,
      put: async () => undefined,
    }),
  });
}

function memory(initial: string | null = null): EndpointMemory & { value: string | null } {
  const state = {
    value: initial,
    read: () => state.value,
    write: (endpoint: string) => {
      state.value = endpoint;
    },
  };
  return state;
}

/** The iPhone's registration: on a resume iOS lists nothing and may not name the subscription. */
function iphone(options: { subscribed: boolean }) {
  return {
    getNotifications: async () => [],
    pushManager: {
      getSubscription: async () => (options.subscribed ? { endpoint: IPHONE } : null),
    },
  };
}

function page(find: (context: { readonly awaySince: number }) => Promise<unknown>) {
  const state = { path: "/bots" };
  const navigate = vi.fn((path: string) => {
    state.path = path;
  });
  const reports: Record<string, unknown>[] = [];
  const controller = createNotificationTapController({
    navigate,
    currentPath: () => state.path,
    takePending: async () => null,
    isVisible: () => true,
    visibility: () => "visible",
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    ack: () => undefined,
    report: (record) => reports.push(record),
    lostTap: {
      find: find as never,
      after: (callback, ms) => void setTimeout(callback, ms),
    },
  });
  return { state, navigate, reports, controller };
}

describe("the 1 Oct 07:16:59 tap, found through the server", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 07:15:30 BST: a fresh launch, when iOS still names the subscription.
    vi.setSystemTime(Date.parse("2026-10-01T06:15:30Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * Away at 07:16:49.948, the Assistant push sent at 07:16:59 (and a CTO push
   * to the laptop), back at 07:18:44.021, looked 2.5 s later at 07:18:46.521.
   * On the resume the worker's list and getNotifications() are empty.
   */
  async function replay(find: (context: { readonly awaySince: number }) => Promise<unknown>) {
    const app = page(find);
    await vi.advanceTimersByTimeAsync(Date.parse("2026-10-01T06:16:49.948Z") - Date.now());
    app.controller.away();
    await vi.advanceTimersByTimeAsync(Date.parse("2026-10-01T06:16:59.100Z") - Date.now());
    return app;
  }

  it("1.60.11 looked only at the phone's own list and opened nothing", async () => {
    phoneCaches();
    const device = iphone({ subscribed: false });
    const app = await replay(({ awaySince }) => findLostTap(device, { awaySince }));
    await vi.advanceTimersByTimeAsync(Date.parse("2026-10-01T06:18:44.021Z") - Date.now());
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.navigate).not.toHaveBeenCalled();
    expect(app.reports.at(-1)).toEqual(
      expect.objectContaining({ reason: "none-shown", outcome: "none" }),
    );
    app.controller.dispose();
  });

  it("asks the server, which still knows what it sent this phone, and opens it once", async () => {
    phoneCaches();
    const server = fakeServer();
    const kept = memory();
    // The fresh launch keeps the endpoint while iOS names it.
    expect(await currentPushEndpoint(iphone({ subscribed: true }), kept)).toBe(IPHONE);
    const find = makeLostTapFinder({
      registration: async () => iphone({ subscribed: false }),
      fetch: server.fetch,
      now: () => Date.now(),
      memory: kept,
    });
    const app = await replay(find);
    server.send(IPHONE, ASSISTANT_CHAT);
    server.send(LAPTOP, CTO_CHAT);
    await vi.advanceTimersByTimeAsync(Date.parse("2026-10-01T06:18:44.021Z") - Date.now());
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);

    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(ASSISTANT_CHAT);
    expect(server.requests).toEqual([{ endpoint: IPHONE, awayMs: 116_573 }]);
    expect(app.reports).toEqual([
      expect.objectContaining({
        event: "lost-tap-check",
        store: "server",
        reason: "server-sent",
        sent: 1,
        outcome: "opened",
        url: ASSISTANT_CHAT,
        awayMs: 114_073,
      }),
      expect.objectContaining({ event: "tap-received", url: ASSISTANT_CHAT, via: "inferred" }),
    ]);

    // Only once: back to the list, away and back again opens nothing.
    app.state.path = "/bots";
    app.controller.away();
    await vi.advanceTimersByTimeAsync(20_000);
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.navigate).toHaveBeenCalledOnce();
    expect(app.reports.at(-1)).toEqual(
      expect.objectContaining({ store: "server", reason: "none-sent", outcome: "none" }),
    );
    app.controller.dispose();
  });
});

describe("the server's answer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the one place every push opens", () => {
    expect(
      decideServerLostTap({
        known: true,
        pushes: [
          { url: ASSISTANT_CHAT, sentAt: "a" },
          { url: ASSISTANT_CHAT, sentAt: "b" },
        ],
      }),
    ).toEqual({ url: ASSISTANT_CHAT, reason: "server-sent", store: "server", sent: 2 });
  });

  it("opens nothing for pushes to different places, or none", () => {
    expect(
      decideServerLostTap({
        known: true,
        pushes: [
          { url: ASSISTANT_CHAT, sentAt: "a" },
          { url: CTO_CHAT, sentAt: "b" },
        ],
      }),
    ).toEqual(expect.objectContaining({ url: null, reason: "several-sent" }));
    expect(decideServerLostTap({ known: true, pushes: [] })).toEqual(
      expect.objectContaining({ url: null, reason: "none-sent", sent: 0 }),
    );
  });

  it("never opens a link that is not an in-app path", () => {
    expect(
      decideServerLostTap({ known: true, pushes: [{ url: "https://evil.example/", sentAt: "a" }] }),
    ).toEqual(expect.objectContaining({ url: null, reason: "none-sent" }));
  });

  it("is no answer when the server does not know the device", () => {
    expect(decideServerLostTap({ known: false, pushes: [] })).toBeNull();
    expect(decideServerLostTap("nonsense")).toBeNull();
  });
});

describe("when the server cannot answer, the phone's own list decides", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const entry = () => [{ key: "chat-x", url: ASSISTANT_CHAT, at: Date.now() - 5_000 }];

  it("falls back on a server error, and says why", async () => {
    phoneCaches(entry());
    const server = fakeServer();
    server.fail(500);
    const find = makeLostTapFinder({
      registration: async () => iphone({ subscribed: true }),
      fetch: server.fetch,
      now: () => Date.now(),
      memory: memory(),
    });
    expect(await find({ awaySince: Date.now() - 60_000 })).toEqual(
      expect.objectContaining({ url: ASSISTANT_CHAT, store: "cache", server: "http-500" }),
    );
  });

  it("falls back when no endpoint is known, without asking the server", async () => {
    phoneCaches(entry());
    const server = fakeServer();
    const find = makeLostTapFinder({
      registration: async () => iphone({ subscribed: false }),
      fetch: server.fetch,
      now: () => Date.now(),
      memory: memory(),
    });
    expect(await find({ awaySince: 0 })).toEqual(
      expect.objectContaining({ url: ASSISTANT_CHAT, server: "no-endpoint" }),
    );
    expect(server.requests).toHaveLength(0);
  });

  it("falls back when the server does not know this device", async () => {
    phoneCaches(entry());
    const server = fakeServer();
    const find = makeLostTapFinder({
      registration: async () => null,
      fetch: server.fetch,
      now: () => Date.now(),
      memory: memory("https://web.push.apple.com/someone-else"),
    });
    expect(await find({ awaySince: 0 })).toEqual(
      expect.objectContaining({ url: ASSISTANT_CHAT, server: "unknown-device" }),
    );
  });

  it("gives up on a server that does not answer in time", async () => {
    const hang = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = askServerForLostTap({
      endpoint: IPHONE,
      awayMs: 1_000,
      fetch: hang as unknown as typeof fetch,
      timeoutMs: 4_000,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await pending).toEqual({ answered: false, reason: "timeout" });
  });

  it("asks for the full lookback when the away time is unknown (a launch)", async () => {
    phoneCaches();
    const server = fakeServer();
    server.send(IPHONE, ASSISTANT_CHAT);
    const find = makeLostTapFinder({
      registration: async () => iphone({ subscribed: true }),
      fetch: server.fetch,
      now: () => Date.now(),
      memory: memory(),
    });
    expect(await find({ awaySince: 0 })).toEqual(
      expect.objectContaining({ url: ASSISTANT_CHAT, store: "server" }),
    );
    expect(server.requests).toEqual([{ endpoint: IPHONE, awayMs: null }]);
  });
});
