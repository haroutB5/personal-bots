import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { findLostTap, SHOWN_CACHE, SHOWN_KEY } from "./lostNotificationTaps";
import { createNotificationTapController, LOST_TAP_GRACE_MS } from "./notificationTap";
import {
  askServerForLostTap,
  currentPushEndpoint,
  decideServerLostTap,
  type EndpointMemory,
  makeLostTapLookups,
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

type Lookups = {
  readonly ask?: (context: { readonly awaySince: number }) => Promise<unknown>;
  readonly find: (context: { readonly awaySince: number }) => Promise<unknown>;
};

/** What the controller does with the two lookups, for the fallback cases. */
async function lookup(lookups: ReturnType<typeof makeLostTapLookups>, awaySince: number) {
  const answer = await lookups.ask({ awaySince });
  if (answer.answered) return answer.look;
  return { ...(await lookups.find({ awaySince })), server: answer.reason };
}

function page(lookups: Lookups) {
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
      ...(lookups.ask === undefined ? {} : { ask: lookups.ask as never }),
      find: lookups.find as never,
      after: (callback, ms) => void setTimeout(callback, ms),
    },
  });
  /** A real notificationclick reaching the page by message. */
  const click = (url: string) =>
    controller.onMessage({ type: "bots:navigate", url, id: `tap-${url}` }, "message");
  return { state, navigate, reports, controller, click };
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
  async function replay(lookups: Lookups) {
    const app = page(lookups);
    await vi.advanceTimersByTimeAsync(Date.parse("2026-10-01T06:16:49.948Z") - Date.now());
    app.controller.away();
    await vi.advanceTimersByTimeAsync(Date.parse("2026-10-01T06:16:59.100Z") - Date.now());
    return app;
  }

  it("1.60.11 looked only at the phone's own list and opened nothing", async () => {
    phoneCaches();
    const device = iphone({ subscribed: false });
    const app = await replay({ find: ({ awaySince }) => findLostTap(device, { awaySince }) });
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
    const lookups = makeLostTapLookups({
      registration: async () => iphone({ subscribed: false }),
      fetch: server.fetch,
      now: () => Date.now(),
      memory: kept,
    });
    const app = await replay(lookups);
    server.send(IPHONE, ASSISTANT_CHAT);
    server.send(LAPTOP, CTO_CHAT);
    await vi.advanceTimersByTimeAsync(Date.parse("2026-10-01T06:18:44.021Z") - Date.now());
    await app.controller.check("cache-visible");
    // Asked at once, not after the grace period: open as soon as it answers.
    await vi.advanceTimersByTimeAsync(0);

    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(ASSISTANT_CHAT);
    expect(server.requests).toEqual([{ endpoint: IPHONE, awayMs: 114_073 }]);
    expect(app.reports).toEqual([
      expect.objectContaining({
        event: "lost-tap-check",
        store: "server",
        reason: "server-sent",
        sent: 1,
        outcome: "opened",
        url: ASSISTANT_CHAT,
        awayMs: 114_073,
        waitedMs: 0,
        requestMs: 0,
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

describe("asking at once, racing a real notificationclick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A server that answers `ms` after it is asked. */
  function slowServer(ms: number, url: string | null) {
    return vi.fn(
      () =>
        new Promise<{ answered: true; look: { url: string | null; reason: string } }>(
          (resolve) =>
            void setTimeout(
              () =>
                resolve({
                  answered: true,
                  look: { url, reason: url ? "server-sent" : "none-sent" },
                }),
              ms,
            ),
        ),
    );
  }

  it("opens on the server's answer, long before the old 2.5 s grace", async () => {
    const find = vi.fn(async () => ({ url: null, reason: "none-shown" }));
    const app = page({ ask: slowServer(150, ASSISTANT_CHAT), find });
    app.controller.away();
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(149);
    expect(app.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(ASSISTANT_CHAT);
    expect(app.reports[0]).toEqual(
      expect.objectContaining({ outcome: "opened", waitedMs: 150, requestMs: 150 }),
    );
    // The phone's list is not read when the server answered.
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(find).not.toHaveBeenCalled();
    app.controller.dispose();
  });

  it("a real click during the request wins: one navigation only", async () => {
    const app = page({
      ask: slowServer(300, ASSISTANT_CHAT),
      find: async () => ({ url: null, reason: "x" }),
    });
    app.controller.away();
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(100);
    app.click(ASSISTANT_CHAT);
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(ASSISTANT_CHAT);
    expect(app.reports).toContainEqual(
      expect.objectContaining({ event: "lost-tap-check", outcome: "tap-arrived" }),
    );
    app.controller.dispose();
  });

  it("a real click for the same chat after the server opened it changes nothing", async () => {
    const app = page({
      ask: slowServer(100, ASSISTANT_CHAT),
      find: async () => ({ url: null, reason: "x" }),
    });
    app.controller.away();
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(100);
    expect(app.navigate).toHaveBeenCalledOnce();
    app.click(ASSISTANT_CHAT);
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS);
    expect(app.navigate).toHaveBeenCalledOnce();
    expect(app.reports.at(-1)).toEqual(
      expect.objectContaining({ event: "tap-received", via: "message", navigated: false }),
    );
    app.controller.dispose();
  });

  it("a real click for another chat after the server answered still goes where tapped", async () => {
    const app = page({
      ask: slowServer(100, ASSISTANT_CHAT),
      find: async () => ({ url: null, reason: "x" }),
    });
    app.controller.away();
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(100);
    app.click(CTO_CHAT);
    expect(app.navigate.mock.calls.map(([path]) => path)).toEqual([ASSISTANT_CHAT, CTO_CHAT]);
    expect(app.state.path).toBe(CTO_CHAT);
    app.controller.dispose();
  });

  it("without a server answer the phone's list still waits out the grace", async () => {
    const find = vi.fn(async () => ({ url: ASSISTANT_CHAT, reason: "one-gone" }));
    const ask = vi.fn(async () => ({ answered: false as const, reason: "no-endpoint" }));
    const app = page({ ask, find });
    app.controller.away();
    await app.controller.check("cache-visible");
    await vi.advanceTimersByTimeAsync(LOST_TAP_GRACE_MS - 1);
    expect(find).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(ASSISTANT_CHAT);
    expect(app.reports[0]).toEqual(
      expect.objectContaining({
        server: "no-endpoint",
        outcome: "opened",
        waitedMs: LOST_TAP_GRACE_MS,
      }),
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
    const lookups = makeLostTapLookups({
      registration: async () => iphone({ subscribed: true }),
      fetch: server.fetch,
      now: () => Date.now(),
      memory: memory(),
    });
    expect(await lookup(lookups, Date.now() - 60_000)).toEqual(
      expect.objectContaining({ url: ASSISTANT_CHAT, store: "cache", server: "http-500" }),
    );
  });

  it("falls back when no endpoint is known, without asking the server", async () => {
    phoneCaches(entry());
    const server = fakeServer();
    const lookups = makeLostTapLookups({
      registration: async () => iphone({ subscribed: false }),
      fetch: server.fetch,
      now: () => Date.now(),
      memory: memory(),
    });
    expect(await lookup(lookups, 0)).toEqual(
      expect.objectContaining({ url: ASSISTANT_CHAT, server: "no-endpoint" }),
    );
    expect(server.requests).toHaveLength(0);
  });

  it("falls back when the server does not know this device", async () => {
    phoneCaches(entry());
    const server = fakeServer();
    const lookups = makeLostTapLookups({
      registration: async () => null,
      fetch: server.fetch,
      now: () => Date.now(),
      memory: memory("https://web.push.apple.com/someone-else"),
    });
    expect(await lookup(lookups, 0)).toEqual(
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

  it("tries once more when the network was not up yet on the wake", async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("Load failed");
      return Response.json({ known: true, pushes: [{ url: ASSISTANT_CHAT, sentAt: "a" }] });
    });
    const pending = askServerForLostTap({
      endpoint: IPHONE,
      awayMs: 1_000,
      fetch: flaky as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({
      answered: true,
      look: expect.objectContaining({ url: ASSISTANT_CHAT }),
    });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("does not retry an HTTP answer, and says when a retry also failed", async () => {
    const refused = vi.fn(async () => new Response("", { status: 403 }));
    expect(
      await askServerForLostTap({ endpoint: IPHONE, awayMs: 0, fetch: refused as never }),
    ).toEqual({ answered: false, reason: "http-403" });
    expect(refused).toHaveBeenCalledOnce();
    const down = vi.fn(async () => {
      throw new TypeError("Load failed");
    });
    const pending = askServerForLostTap({ endpoint: IPHONE, awayMs: 0, fetch: down as never });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ answered: false, reason: "failed-retried" });
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("asks for the full lookback when the away time is unknown (a launch)", async () => {
    phoneCaches();
    const server = fakeServer();
    server.send(IPHONE, ASSISTANT_CHAT);
    const lookups = makeLostTapLookups({
      registration: async () => iphone({ subscribed: true }),
      fetch: server.fetch,
      now: () => Date.now(),
      memory: memory(),
    });
    expect(await lookup(lookups, 0)).toEqual(
      expect.objectContaining({ url: ASSISTANT_CHAT, store: "server" }),
    );
    expect(server.requests).toEqual([{ endpoint: IPHONE, awayMs: null }]);
  });
});
