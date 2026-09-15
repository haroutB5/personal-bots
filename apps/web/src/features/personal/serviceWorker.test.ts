import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { takePendingNavigation } from "./serviceWorker";

const NOW = 1_800_000_000_000;

function stubPending(body: unknown) {
  const store = new Map<string, Response>();
  if (body !== undefined) store.set("/__bots-pending-nav__", new Response(JSON.stringify(body)));
  const cache = {
    match: vi.fn(async (key: string) => store.get(key)),
    delete: vi.fn(async (key: string) => store.delete(key)),
  };
  vi.stubGlobal("caches", { open: vi.fn(async () => cache) });
  return cache;
}

describe("takePendingNavigation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a fresh deep link once and clears it", async () => {
    const cache = stubPending({ url: "/bots/bot-1/thread-1", at: NOW - 5_000 });
    expect(await takePendingNavigation(NOW)).toBe("/bots/bot-1/thread-1");
    expect(cache.delete).toHaveBeenCalledWith("/__bots-pending-nav__");
    expect(await takePendingNavigation(NOW)).toBeNull();
  });

  it("ignores a stale tap", async () => {
    stubPending({ url: "/bots/bot-1/thread-1", at: NOW - 3 * 60_000 });
    expect(await takePendingNavigation(NOW)).toBeNull();
  });

  it("ignores an unsafe path", async () => {
    stubPending({ url: "//evil.example/x", at: NOW });
    expect(await takePendingNavigation(NOW)).toBeNull();
  });

  it("returns null when nothing is saved or storage is missing", async () => {
    stubPending(undefined);
    expect(await takePendingNavigation(NOW)).toBeNull();
    vi.unstubAllGlobals();
    vi.stubGlobal("caches", undefined);
    expect(await takePendingNavigation(NOW)).toBeNull();
  });
});
