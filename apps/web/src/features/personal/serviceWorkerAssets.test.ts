// @effect-diagnostics-next-line nodeBuiltinImport:off - evaluates the shipped worker in an isolated Node VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");

function fakeResponse(contentType: string, body = "") {
  const response = {
    ok: true,
    type: "basic",
    redirected: false,
    body,
    headers: new Headers({ "Content-Type": contentType }),
    clone: () => response,
  };
  return response;
}

type FakeResponse = ReturnType<typeof fakeResponse>;

/** In-memory Cache Storage that keeps creation order like the real one. */
function cacheStorage(initial: Record<string, Record<string, FakeResponse>>) {
  const store = new Map<string, Map<string, FakeResponse>>(
    Object.entries(initial).map(([name, entries]) => [name, new Map(Object.entries(entries))]),
  );
  const keyOf = (request: unknown) =>
    typeof request === "string" ? request : new URL((request as { url: string }).url).pathname;
  return {
    store,
    keys: async () => [...store.keys()],
    delete: vi.fn(async (name: string) => store.delete(name)),
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      const cache = store.get(name)!;
      return {
        put: async (request: unknown, response: FakeResponse) =>
          cache.set(keyOf(request), response),
      };
    },
    match: async (request: unknown, options?: { cacheName?: string }) => {
      const names = options?.cacheName ? [options.cacheName] : [...store.keys()];
      for (const name of names) {
        const hit = store.get(name)?.get(keyOf(request));
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

function worker(version: string, caches: ReturnType<typeof cacheStorage>, network: FakeResponse) {
  const handlers = new Map<string, (event: unknown) => void>();
  const fetch = vi.fn(async () => network);
  const claim = vi.fn(async () => undefined);
  NodeVM.runInNewContext(source, {
    URL,
    Response,
    self: {
      location: new URL(`https://bots.example/sw.js?v=${version}`),
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      registration: { showNotification: vi.fn() },
      clients: { claim },
    },
    fetch,
    setTimeout,
    clearTimeout,
    caches,
  });
  return { handlers, fetch };
}

async function getAsset(app: ReturnType<typeof worker>, path: string) {
  let result: Promise<unknown> | undefined;
  const background: Promise<unknown>[] = [];
  app.handlers.get("fetch")!({
    request: {
      method: "GET",
      mode: "cors",
      headers: new Headers(),
      url: `https://bots.example${path}`,
    },
    respondWith: (value: Promise<unknown>) => {
      result = value;
    },
    waitUntil: (value: Promise<unknown>) => background.push(value),
  });
  const response = await result;
  await Promise.all(background);
  return response;
}

describe("service worker build assets", () => {
  it.each([
    ["/assets/Chunk-11111111.js", "text/html; charset=utf-8"],
    ["/assets/Chunk-11111111.js", "text/plain"],
    ["/assets/index-11111111.css", "text/html"],
    ["/assets/logo-11111111.svg", "text/html"],
  ])("never caches %s answered as %s", async (path, type) => {
    const caches = cacheStorage({});
    const network = fakeResponse(type, "<html>");
    const app = worker("2", caches, network);
    expect(await getAsset(app, path)).toBe(network);
    expect(caches.store.get("bots-shell-2")?.size ?? 0).toBe(0);
  });

  it.each([
    ["/assets/Chunk-11111111.js", "text/javascript; charset=utf-8"],
    ["/assets/Chunk-11111111.mjs", "application/javascript"],
    ["/assets/index-11111111.css", "text/css"],
    ["/assets/font-11111111.woff2", "font/woff2"],
  ])("caches %s answered as %s", async (path, type) => {
    const caches = cacheStorage({});
    const app = worker("2", caches, fakeResponse(type));
    await getAsset(app, path);
    expect(caches.store.get("bots-shell-2")?.has(path)).toBe(true);
  });

  it("serves a chunk from the previous version's cache without the network", async () => {
    const old = fakeResponse("text/javascript", "old chunk");
    const caches = cacheStorage({
      "bots-shell-1": { "/assets/Old-11111111.js": old },
      "bots-shell-2": {},
    });
    const app = worker("2", caches, fakeResponse("text/html"));
    expect(await getAsset(app, "/assets/Old-11111111.js")).toBe(old);
    expect(app.fetch).not.toHaveBeenCalled();
  });

  it("skips an HTML copy an older worker saved under a chunk URL", async () => {
    const caches = cacheStorage({
      "bots-shell-1": { "/assets/Old-11111111.js": fakeResponse("text/html", "<html>") },
    });
    const network = fakeResponse("text/javascript", "real chunk");
    const app = worker("2", caches, network);
    expect(await getAsset(app, "/assets/Old-11111111.js")).toBe(network);
    expect(app.fetch).toHaveBeenCalledOnce();
  });

  it("keeps exactly the previous version's cache on activate", async () => {
    const caches = cacheStorage({
      "bots-shell-1": {},
      "bots-pending-nav": {},
      "bots-shell-2": {},
      "bots-shell-3": {},
      "bots-shell-4": {},
    });
    const app = worker("4", caches, fakeResponse("text/html"));
    let done: Promise<unknown> | undefined;
    app.handlers.get("activate")!({
      waitUntil: (value: Promise<unknown>) => {
        done = value;
      },
    });
    await done;
    expect([...caches.store.keys()]).toEqual(["bots-pending-nav", "bots-shell-3", "bots-shell-4"]);
  });

  it("keeps a lone previous cache and deletes nothing on a first install", async () => {
    for (const initial of [["bots-shell-1"], []]) {
      const caches = cacheStorage(Object.fromEntries(initial.map((name) => [name, {}])));
      const app = worker("2", caches, fakeResponse("text/html"));
      let done: Promise<unknown> | undefined;
      app.handlers.get("activate")!({
        waitUntil: (value: Promise<unknown>) => {
          done = value;
        },
      });
      await done;
      expect(caches.delete).not.toHaveBeenCalled();
    }
  });
});
