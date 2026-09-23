// @effect-diagnostics-next-line nodeBuiltinImport:off - evaluates the shipped worker in an isolated Node VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");

function worker(
  storageFails: boolean,
  networkFails = false,
  hasShell = false,
  clients: unknown = undefined,
  extra: Record<string, unknown> = {},
) {
  const handlers = new Map<string, (event: unknown) => void>();
  const response = {
    ok: true,
    type: "basic",
    redirected: false,
    headers: new Headers({ "Content-Type": "text/html" }),
    clone: () => response,
  };
  const cache = {
    put: vi.fn(async () => {
      if (storageFails) throw new Error("Quota exceeded");
    }),
  };
  const offline = { offline: true };
  const fetch = vi.fn(async () => {
    if (networkFails) throw new Error("Offline");
    return response;
  });
  const showNotification = vi.fn(async () => undefined);
  NodeVM.runInNewContext(source, {
    URL,
    Response,
    self: {
      location: new URL("https://bots.example/sw.js?v=test"),
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      registration: { showNotification },
      clients,
    },
    fetch,
    setTimeout,
    clearTimeout,
    ...extra,
    caches: {
      match: async () => {
        if (storageFails) throw new Error("Storage unavailable");
        return networkFails || hasShell ? offline : undefined;
      },
      open: async () => cache,
    },
  });
  return { handlers, response, offline, fetch, showNotification, cache };
}

describe("personal service worker", () => {
  it.each(["navigate", "cors"])("serves network %s responses when storage fails", async (mode) => {
    const app = worker(true);
    let result: Promise<unknown> | undefined;
    const background: Promise<unknown>[] = [];
    app.handlers.get("fetch")!({
      request: {
        method: "GET",
        mode,
        headers: new Headers(),
        url: `https://bots.example/${mode === "navigate" ? "bots" : "assets/app-123.js"}`,
      },
      respondWith: (value: Promise<unknown>) => {
        result = value;
      },
      waitUntil: (value: Promise<unknown>) => background.push(value),
    });
    expect(await result).toBe(app.response);
    await Promise.all(background);
    expect(app.fetch).toHaveBeenCalledOnce();
  });

  it("uses the cached shell when the laptop is unreachable", async () => {
    const app = worker(false, true);
    let result: Promise<unknown> | undefined;
    app.handlers.get("fetch")!({
      request: {
        method: "GET",
        mode: "navigate",
        headers: new Headers(),
        url: "https://bots.example/bots",
      },
      respondWith: (value: Promise<unknown>) => {
        result = value;
      },
      waitUntil: () => undefined,
    });
    expect(await result).toBe(app.offline);
  });

  it("returns the saved shell before a slow tunnel responds", async () => {
    const app = worker(false, false, true);
    app.fetch.mockImplementation(() => new Promise(() => {}));
    let result: Promise<unknown> | undefined;
    app.handlers.get("fetch")!({
      request: {
        method: "GET",
        mode: "navigate",
        headers: new Headers(),
        url: "https://bots.example/bots",
      },
      respondWith: (value: Promise<unknown>) => {
        result = value;
      },
      waitUntil: () => undefined,
    });
    expect(await result).toBe(app.offline);
    expect(app.fetch).toHaveBeenCalledOnce();
  });

  it.each(["reload", "no-cache"])("refreshes the shell for a %s navigation", async (cache) => {
    const app = worker(false, false, true);
    let result: Promise<unknown> | undefined;
    app.handlers.get("fetch")!({
      request: {
        method: "GET",
        mode: "navigate",
        cache,
        headers: new Headers(),
        url: "https://bots.example/bots",
      },
      respondWith: (value: Promise<unknown>) => {
        result = value;
      },
      waitUntil: () => undefined,
    });
    expect(await result).toBe(app.response);
  });

  it("shows a fallback notification for a null push payload", async () => {
    const app = worker(false);
    let result: Promise<unknown> | undefined;
    app.handlers.get("push")!({
      data: { json: () => null },
      waitUntil: (value: Promise<unknown>) => {
        result = value;
      },
    });
    await result;
    expect(app.showNotification).toHaveBeenCalledWith(
      "Bots",
      expect.objectContaining({ body: "" }),
    );
  });

  describe("notification taps", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Same-process stand-in: delivers to every other instance with the same name. */
    function broadcastChannels() {
      const open: FakeChannel[] = [];
      class FakeChannel {
        readonly name: string;
        readonly listeners: Array<(event: { data: unknown }) => void> = [];
        readonly sent: unknown[] = [];
        constructor(name: string) {
          this.name = name;
          open.push(this);
        }
        addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
          this.listeners.push(listener);
        }
        postMessage(data: unknown) {
          this.sent.push(data);
          for (const other of open) {
            if (other === this || other.name !== this.name) continue;
            queueMicrotask(() => other.listeners.forEach((listener) => listener({ data })));
          }
        }
      }
      return { FakeChannel, open };
    }

    function windowClient(overrides: Record<string, unknown> = {}) {
      return {
        url: "https://bots.example/bots",
        visibilityState: "visible",
        focused: true,
        focus: vi.fn(async () => undefined),
        navigate: vi.fn(async () => undefined),
        postMessage: vi.fn(),
        ...overrides,
      };
    }

    function tap(app: ReturnType<typeof worker>, url = "/bots/bot-1/thread-1") {
      let result: Promise<unknown> | undefined;
      app.handlers.get("notificationclick")!({
        notification: { close: () => undefined, data: { url } },
        waitUntil: (value: Promise<unknown>) => {
          result = value;
        },
      });
      return result!;
    }

    function diagRecords(app: ReturnType<typeof worker>) {
      return app.fetch.mock.calls
        .filter((call) => String(call[0 as never]) === "/api/personal/client-diag")
        .map((call) => JSON.parse((call as unknown as [string, { body: string }])[1].body));
    }

    function clickRecord(app: ReturnType<typeof worker>) {
      return diagRecords(app).find((record) => record.event === "notificationclick");
    }

    it("posts a start line before anything else, without keepalive", () => {
      // No timers advanced and no await: the line must already be on its way,
      // so a missing line on the phone means the handler never ran.
      const app = worker(false, false, false, { matchAll: async () => [], openWindow: vi.fn() });
      void tap(app);
      const [start] = diagRecords(app);
      expect(start).toMatchObject({
        event: "notificationclick-start",
        url: "/bots/bot-1/thread-1",
        id: expect.any(String),
      });
      const init = (app.fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(init.keepalive).toBeUndefined();
    });

    it("hands the deep link to the open app even when focus is refused", async () => {
      vi.useFakeTimers();
      // iOS brings the installed app forward itself and can reject focus();
      // the deep link must still arrive, and survive a dropped message.
      const client = windowClient({
        focus: vi.fn(async () => {
          throw new Error("InvalidAccessError");
        }),
      });
      const openWindow = vi.fn(async () => undefined);
      const app = worker(false, false, false, {
        matchAll: async () => [client],
        openWindow,
      });
      const done = tap(app);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.postMessage).toHaveBeenCalledWith({
        type: "bots:navigate",
        url: "/bots/bot-1/thread-1",
        id: expect.any(String),
      });
      expect(app.cache.put).toHaveBeenCalledWith("/__bots-pending-nav__", expect.anything());
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(openWindow).not.toHaveBeenCalled();
    });

    it("stands down when the foreground page acknowledges the tap", async () => {
      vi.useFakeTimers();
      const { FakeChannel } = broadcastChannels();
      const client = windowClient();
      const app = worker(
        false,
        false,
        false,
        { matchAll: async () => [client], openWindow: vi.fn() },
        { BroadcastChannel: FakeChannel },
      );
      // The page: acks whatever tap reaches it over the channel.
      const pageChannel = new FakeChannel("bots-nav");
      pageChannel.addEventListener("message", ({ data }) => {
        const message = data as { type: string; id: string };
        if (message.type === "bots:navigate") {
          /* eslint-disable unicorn/require-post-message-target-origin -- BroadcastChannel stand-in. */
          pageChannel.postMessage({
            type: "bots:navigate-ack",
            id: message.id,
            via: "broadcast",
            visibility: "visible",
          });
          /* eslint-enable unicorn/require-post-message-target-origin */
        }
      });
      const done = tap(app);
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(client.navigate).not.toHaveBeenCalled();
      const record = clickRecord(app);
      expect(record).toMatchObject({
        event: "notificationclick",
        url: "/bots/bot-1/thread-1",
        broadcast: true,
        cache: true,
        route: "page",
        ack: { via: "broadcast", visibility: "visible" },
        clients: [{ path: "/bots", visibility: "visible", focused: true }],
      });
    });

    it("navigates the window itself when no page acts on the tap", async () => {
      vi.useFakeTimers();
      // The iOS foreground failure: messages go nowhere and nothing reads the
      // saved copy. The worker must still land the user in the chat.
      const client = windowClient();
      const app = worker(false, false, false, {
        matchAll: async () => [client],
        openWindow: vi.fn(),
      });
      const done = tap(app);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(client.navigate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      expect(client.navigate).toHaveBeenCalledExactlyOnceWith(
        "https://bots.example/bots/bot-1/thread-1",
      );
      expect(clickRecord(app)).toMatchObject({ route: "client.navigate", ack: null });
    });

    it("opens a window when none is found, and still broadcasts the link", async () => {
      vi.useFakeTimers();
      const { FakeChannel, open } = broadcastChannels();
      const openWindow = vi.fn(async () => undefined);
      const app = worker(
        false,
        false,
        false,
        { matchAll: async () => [], openWindow },
        { BroadcastChannel: FakeChannel },
      );
      const done = tap(app);
      await vi.advanceTimersByTimeAsync(10_000);
      await done;
      expect(openWindow).toHaveBeenCalledExactlyOnceWith(
        "https://bots.example/bots/bot-1/thread-1",
      );
      expect(open[0]?.sent).toContainEqual(
        expect.objectContaining({ type: "bots:navigate", url: "/bots/bot-1/thread-1" }),
      );
      expect(clickRecord(app)).toMatchObject({ route: "openWindow", clients: [] });
    });

    it("tells open windows a notification was shown", async () => {
      const { FakeChannel, open } = broadcastChannels();
      const client = windowClient();
      const app = worker(
        false,
        false,
        false,
        { matchAll: async () => [client] },
        { BroadcastChannel: FakeChannel },
      );
      let result: Promise<unknown> | undefined;
      app.handlers.get("push")!({
        data: { json: () => ({ title: "Ada replied", url: "/bots/bot-1/thread-1" }) },
        waitUntil: (value: Promise<unknown>) => {
          result = value;
        },
      });
      await result;
      expect(app.showNotification).toHaveBeenCalledOnce();
      expect(client.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "bots:push-shown" }),
      );
      expect(open[0]?.sent).toContainEqual(expect.objectContaining({ type: "bots:push-shown" }));
      // One diag line per push: proves the worker reaches the server, and
      // records whether the app was in front when the banner appeared.
      expect(diagRecords(app)).toEqual([
        {
          event: "push-shown",
          sw: "test",
          url: "/bots/bot-1/thread-1",
          broadcast: true,
          clients: [{ path: "/bots", visibility: "visible", focused: true }],
        },
      ]);
    });
  });
});
