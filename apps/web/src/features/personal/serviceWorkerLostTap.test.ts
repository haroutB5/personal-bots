// @effect-diagnostics-next-line nodeBuiltinImport:off - evaluates the shipped worker in an isolated Node VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  findLostTap,
  forgetShownNotifications,
  type NotificationLister,
  RECENT_TAP_WINDOW_MS,
} from "./lostNotificationTaps";

const source = NodeFS.readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");

/** Cache Storage shared by the worker and the page, as on the phone. */
function memoryCaches() {
  const stores = new Map<string, Map<string, string>>();
  const open = async (name: string) => {
    const store = stores.get(name) ?? new Map<string, string>();
    stores.set(name, store);
    return {
      match: async (key: string) => {
        const body = store.get(key);
        return body === undefined ? undefined : new Response(body);
      },
      put: async (key: string, response: Response) => {
        store.set(key, await response.text());
      },
      delete: async (key: string) => store.delete(key),
    };
  };
  return { open, keys: async () => [...stores.keys()], match: async () => undefined };
}

/**
 * The page's view of the same storage as iOS showed it on 30 Sep: whatever it
 * read first it keeps reading, so later writes by the worker never reach it
 * (22:37:55 push-shown, 22:37:57 lost-tap-check shown:0). Its own writes go
 * through.
 */
function stalePageView(shared: ReturnType<typeof memoryCaches>) {
  const seen = new Map<string, string | undefined>();
  const open = async (name: string) => {
    const cache = await shared.open(name);
    return {
      match: async (key: string) => {
        const id = `${name} ${key}`;
        if (!seen.has(id)) {
          const response = await cache.match(key);
          seen.set(id, response === undefined ? undefined : await response.text());
        }
        const body = seen.get(id);
        return body === undefined ? undefined : new Response(body);
      },
      put: async (key: string, response: Response) => {
        const body = await response.text();
        seen.set(`${name} ${key}`, body);
        await cache.put(key, new Response(body));
      },
    };
  };
  return { open, keys: shared.keys, match: shared.match };
}

interface Shown {
  readonly title: string;
  readonly tag?: string;
  readonly data: { readonly url: string };
}

function phone(options: { readonly stalePage?: boolean } = {}) {
  const caches = memoryCaches();
  const center: Shown[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  NodeVM.runInNewContext(source, {
    URL,
    Response,
    self: {
      location: new URL("https://bots.example/sw.js?v=test"),
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      registration: {
        showNotification: async (title: string, options: Omit<Shown, "title">) => {
          const index = center.findIndex((n) => options.tag && n.tag === options.tag);
          if (index !== -1) center.splice(index, 1);
          center.push({ title, ...options });
        },
      },
      clients: { matchAll: async () => [], openWindow: async () => null },
    },
    fetch: async () => new Response("{}"),
    // The faked page clock, so worker and page agree on "now".
    Date,
    setTimeout,
    clearTimeout,
    caches,
  });
  vi.stubGlobal("caches", options.stalePage ? stalePageView(caches) : caches);
  // The page's controller: messages reach the worker's message handler, with
  // their ports, as on the phone.
  const worker = {
    postMessage: (message: unknown, transfer: Transferable[] = []) => {
      handlers.get("message")!({
        data: message,
        ports: transfer,
        waitUntil: (value: Promise<unknown>) => void value,
      });
    },
  };
  vi.stubGlobal("navigator", { serviceWorker: { controller: worker } });
  const registration = { getNotifications: async () => [...center] };
  const push = async (payload: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    handlers.get("push")!({
      data: { json: () => payload },
      waitUntil: (value: Promise<unknown>) => pending.push(value),
    });
    await Promise.all(pending);
  };
  const take = (url: string) => {
    const index = center.findIndex((n) => n.data.url === url);
    return center.splice(index, 1)[0]!;
  };
  const run = async (name: string, notification: Shown) => {
    const pending: Promise<unknown>[] = [];
    handlers.get(name)!({
      notification: { ...notification, close: () => undefined },
      waitUntil: (value: Promise<unknown>) => pending.push(value),
    });
    await Promise.all(pending);
  };
  return { center, registration, push, take, run };
}

const ASSISTANT_TASK = "/tasks/50cd83dc-e90e-440c-9876-a9d9a8865dd6";
const CTO_CHAT = "/bots/969c2998/a6a6a26e";
const ASSISTANT_CHAT = "/bots/personal-seed-assistant/0c4b1d06-0852-4d28-8904-6ca40ac017e8";

async function lostUrl(
  app: { readonly registration: NotificationLister },
  options?: { readonly awaySince?: number },
) {
  return (await findLostTap(app.registration, options)).url;
}

describe("worker and page find a tap iOS dropped", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("finds the Assistant task notification that left Notification Center with no click", async () => {
    const app = phone();
    await app.push({ title: "CTO", url: CTO_CHAT });
    await app.push({
      title: "Assistant finished",
      url: ASSISTANT_TASK,
      tag: "task-50cd83dc-e90e-440c-9876-a9d9a8865dd6",
    });
    app.take(ASSISTANT_TASK); // tapped: iOS removed it and dispatched nothing
    expect(await lostUrl(app)).toBe(ASSISTANT_TASK);
    // Once only: the app went away again before the next return.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await lostUrl(app, { awaySince: Date.now() })).toBeNull();
  });

  it("does not guess a tap the worker already handled", async () => {
    const app = phone();
    await app.push({ title: "Assistant finished", url: ASSISTANT_TASK, tag: "task-1" });
    const tapped = app.run("notificationclick", app.take(ASSISTANT_TASK));
    await vi.advanceTimersByTimeAsync(10_000); // no page answers: the worker gives up waiting
    await tapped;
    expect(await lostUrl(app)).toBeNull();
  });

  it("does not guess a notification the user swiped away", async () => {
    const app = phone();
    await app.push({ title: "Assistant finished", url: ASSISTANT_TASK, tag: "task-1" });
    await app.run("notificationclose", app.take(ASSISTANT_TASK));
    expect(await lostUrl(app)).toBeNull();
  });

  it("does not guess a notification the page closed itself", async () => {
    const app = phone();
    await app.push({ title: "CTO", url: CTO_CHAT });
    app.take(CTO_CHAT);
    await forgetShownNotifications(["chat-a6a6a26e"]);
    expect(await lostUrl(app)).toBeNull();
  });

  it("keeps one entry per chat when a newer notification replaces the older", async () => {
    const app = phone();
    await app.push({ title: "CTO", url: CTO_CHAT });
    await app.push({ title: "CTO again", url: CTO_CHAT });
    expect(app.center).toHaveLength(1);
    app.take(CTO_CHAT);
    expect(await lostUrl(app)).toBe(CTO_CHAT);
  });

  // 30 Sep 21:28 and 21:33 (live 1.60.8): two Assistant replies for one chat
  // while the app sat suspended, the second tapped at once. No click reached
  // the worker, the app resumed on /bots, and nothing was opened: iOS still
  // listed the tapped notification (as on 24-26 Sep, when a resume cleanup
  // found and closed the just-tapped one, closed:1), so none was "missing".
  it("opens the chat whose notification was tapped when iOS still lists it", async () => {
    const app = phone();
    await app.push({ title: "Assistant", url: ASSISTANT_CHAT });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 22_000);
    await app.push({ title: "Assistant", url: ASSISTANT_CHAT });
    expect(app.center).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    const look = await findLostTap(app.registration, { awaySince: Date.now() - 6 * 60_000 });
    expect(look).toEqual(
      expect.objectContaining({
        url: ASSISTANT_CHAT,
        reason: "recent",
        shown: 1,
        listed: 1,
        gone: 0,
      }),
    );
    // Once only, even though iOS keeps listing it.
    expect(await lostUrl(app)).toBeNull();
  });

  // 30 Sep, live 1.60.9: the app launched at 22:37:02 (list read, empty), went
  // away at 22:37:39, CTO's reply was shown at 22:37:55 and tapped at once.
  // The resumed page read shown:0 at 22:37:57: its own view of the worker's
  // Cache Storage never saw the write.
  it("finds the tap when the resumed page's own storage view is stale", async () => {
    const app = phone({ stalePage: true });
    expect(await lostUrl(app)).toBeNull();
    await vi.advanceTimersByTimeAsync(37_000);
    const awaySince = Date.now();
    await vi.advanceTimersByTimeAsync(15_800);
    await app.push({ title: "CTO", url: CTO_CHAT });
    app.take(CTO_CHAT); // tapped; iOS listed nothing (22:16: listed 0)
    await vi.advanceTimersByTimeAsync(2_500);
    const look = await findLostTap(app.registration, { awaySince });
    expect(look).toEqual(
      expect.objectContaining({ url: CTO_CHAT, reason: "one-gone", shown: 1, store: "worker" }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await lostUrl(app, { awaySince: Date.now() })).toBeNull();
  });

  it("finds it through the worker when iOS still lists the tapped notification", async () => {
    const app = phone({ stalePage: true });
    expect(await lostUrl(app)).toBeNull();
    const awaySince = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    await app.push({ title: "Assistant", url: ASSISTANT_CHAT });
    await app.push({ title: "Assistant", url: ASSISTANT_CHAT });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await findLostTap(app.registration, { awaySince })).toEqual(
      expect.objectContaining({ url: ASSISTANT_CHAT, reason: "recent", listed: 1 }),
    );
  });

  it("opens a recent tap even when iOS lists none of several on the list", async () => {
    const app = phone({ stalePage: true });
    await app.push({ title: "Assistant", url: ASSISTANT_TASK, tag: "task-1" });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const awaySince = Date.now();
    await vi.advanceTimersByTimeAsync(60_000);
    await app.push({ title: "CTO", url: CTO_CHAT });
    app.center.length = 0;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await findLostTap(app.registration, { awaySince })).toEqual(
      expect.objectContaining({ url: CTO_CHAT, reason: "recent", gone: 2, listed: 0 }),
    );
  });

  it("opens the tapped chat on a cold launch too", async () => {
    const app = phone();
    await app.push({ title: "Assistant", url: ASSISTANT_CHAT });
    await app.push({ title: "Assistant", url: ASSISTANT_CHAT });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await lostUrl(app, { awaySince: 0 })).toBe(ASSISTANT_CHAT);
  });

  it("does not guess a notification that arrived while the app was open", async () => {
    const app = phone();
    await app.push({ title: "Assistant", url: ASSISTANT_CHAT });
    await vi.advanceTimersByTimeAsync(20_000);
    const awaySince = Date.now();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await lostUrl(app, { awaySince })).toBeNull();
  });

  it("opens nothing when the app is opened from its icon well after a push", async () => {
    const app = phone();
    await app.push({ title: "Assistant finished", url: ASSISTANT_TASK, tag: "task-1" });
    await vi.advanceTimersByTimeAsync(RECENT_TAP_WINDOW_MS + 1_000);
    const look = await findLostTap(app.registration);
    expect(look).toEqual(expect.objectContaining({ url: null, reason: "none-recent", listed: 1 }));
  });
});
