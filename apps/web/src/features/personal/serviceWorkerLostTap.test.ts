// @effect-diagnostics-next-line nodeBuiltinImport:off - evaluates the shipped worker in an isolated Node VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { findLostTap, forgetShownNotifications } from "./lostNotificationTaps";

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

interface Shown {
  readonly title: string;
  readonly tag?: string;
  readonly data: { readonly url: string };
}

function phone() {
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
  vi.stubGlobal("caches", caches);
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
    expect(await findLostTap(app.registration)).toBe(ASSISTANT_TASK);
    // Once only.
    expect(await findLostTap(app.registration)).toBeNull();
  });

  it("does not guess a tap the worker already handled", async () => {
    const app = phone();
    await app.push({ title: "Assistant finished", url: ASSISTANT_TASK, tag: "task-1" });
    const tapped = app.run("notificationclick", app.take(ASSISTANT_TASK));
    await vi.advanceTimersByTimeAsync(10_000); // no page answers: the worker gives up waiting
    await tapped;
    expect(await findLostTap(app.registration)).toBeNull();
  });

  it("does not guess a notification the user swiped away", async () => {
    const app = phone();
    await app.push({ title: "Assistant finished", url: ASSISTANT_TASK, tag: "task-1" });
    await app.run("notificationclose", app.take(ASSISTANT_TASK));
    expect(await findLostTap(app.registration)).toBeNull();
  });

  it("does not guess a notification the page closed itself", async () => {
    const app = phone();
    await app.push({ title: "CTO", url: CTO_CHAT });
    app.take(CTO_CHAT);
    await forgetShownNotifications(["chat-a6a6a26e"]);
    expect(await findLostTap(app.registration)).toBeNull();
  });

  it("keeps one entry per chat when a newer notification replaces the older", async () => {
    const app = phone();
    await app.push({ title: "CTO", url: CTO_CHAT });
    await app.push({ title: "CTO again", url: CTO_CHAT });
    expect(app.center).toHaveLength(1);
    app.take(CTO_CHAT);
    expect(await findLostTap(app.registration)).toBe(CTO_CHAT);
  });

  it("opens nothing when the app is opened from its icon", async () => {
    const app = phone();
    await app.push({ title: "Assistant finished", url: ASSISTANT_TASK, tag: "task-1" });
    expect(await findLostTap(app.registration)).toBeNull();
  });
});
