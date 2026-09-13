// @effect-diagnostics-next-line nodeBuiltinImport:off - evaluates the shipped worker in an isolated Node VM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

const source = NodeFS.readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");

function worker(storageFails: boolean, networkFails = false, hasShell = false) {
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
    self: {
      location: new URL("https://bots.example/sw.js?v=test"),
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      registration: { showNotification },
    },
    fetch,
    caches: {
      match: async () => {
        if (storageFails) throw new Error("Storage unavailable");
        return networkFails || hasShell ? offline : undefined;
      },
      open: async () => cache,
    },
  });
  return { handlers, response, offline, fetch, showNotification };
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
});
