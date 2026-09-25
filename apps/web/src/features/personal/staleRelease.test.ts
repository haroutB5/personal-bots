import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { takeBootVersionText } from "./appVersion";
import { checkStaleReleaseAtBoot, decideStaleReload, dropSavedShell } from "./staleRelease";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

describe("decideStaleReload", () => {
  it("reloads once per new release, then stops", () => {
    const storage = memoryStorage();
    const input = { enabled: true, running: "index-old.js", served: "index-new.js", storage };
    expect(decideStaleReload(input)).toEqual({ reload: true, target: "index-new.js" });
    // The reload came back on the old bundle again: no loop.
    expect(decideStaleReload(input)).toEqual({ reload: false, reason: "already-reloaded" });
    // Another release later gets its own reload.
    expect(decideStaleReload({ ...input, served: "index-newer.js" }).reload).toBe(true);
  });

  it("clears the guard once the running bundle matches", () => {
    const storage = memoryStorage();
    const stale = { enabled: true, running: "index-old.js", served: "index-new.js", storage };
    decideStaleReload(stale);
    expect(decideStaleReload({ ...stale, running: "index-new.js" })).toEqual({
      reload: false,
      reason: "current",
    });
    expect(decideStaleReload(stale).reload).toBe(true);
  });

  it("never reloads when off, unknown or without storage", () => {
    const storage = memoryStorage();
    const base = { enabled: true, running: "index-old.js", served: "index-new.js", storage };
    expect(decideStaleReload({ ...base, enabled: false }).reload).toBe(false);
    expect(decideStaleReload({ ...base, running: null }).reload).toBe(false);
    expect(decideStaleReload({ ...base, served: null }).reload).toBe(false);
    expect(decideStaleReload({ ...base, storage: null }).reload).toBe(false);
    const throwing = {
      ...storage,
      setItem: () => {
        throw new Error("Quota");
      },
    };
    expect(decideStaleReload({ ...base, storage: throwing })).toEqual({
      reload: false,
      reason: "no-storage",
    });
  });
});

describe("dropSavedShell", () => {
  it("deletes only the saved shell entry from shell caches", async () => {
    const deleted: string[] = [];
    await dropSavedShell({
      keys: async () => ["bots-shell-1", "bots-pending-nav", "bots-shell-2"],
      open: async (name: string) =>
        ({ delete: async (key: string) => (deleted.push(`${name}:${key}`), true) }) as never,
    });
    expect(deleted).toEqual(["bots-shell-1:/__bots-shell__", "bots-shell-2:/__bots-shell__"]);
  });

  it("tolerates missing or failing storage", async () => {
    await dropSavedShell(undefined);
    await dropSavedShell({
      keys: async () => {
        throw new Error("Storage unavailable");
      },
      open: async () => ({}) as never,
    });
  });
});

describe("checkStaleReleaseAtBoot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    takeBootVersionText();
  });

  function boot(entry: string | null, served: string) {
    const storage = memoryStorage();
    return {
      doc: {
        querySelectorAll: () =>
          (entry === null ? [] : [{ getAttribute: () => `/assets/${entry}` }]) as never,
      },
      fetch: vi.fn(
        async () =>
          new Response(`release=abc
client=${served}
`),
      ),
      storage: () => storage,
      caches: undefined,
      reload: vi.fn(),
    };
  }

  it("reloads a page booted on an older bundle straight away, once", async () => {
    const page = boot("index-Old11111.js", "index-New22222.js");
    const onReload = vi.fn();
    expect((await checkStaleReleaseAtBoot(onReload, page)).reload).toBe(true);
    expect(onReload).toHaveBeenCalledOnce();
    expect(page.reload).toHaveBeenCalledOnce();
    takeBootVersionText();
    // Came back stale again: the guard stops a second reload.
    expect(await checkStaleReleaseAtBoot(onReload, page)).toEqual({
      reload: false,
      reason: "already-reloaded",
    });
    expect(page.reload).toHaveBeenCalledOnce();
  });

  it("leaves a current page and dev builds alone", async () => {
    const current = boot("index-New22222.js", "index-New22222.js");
    expect((await checkStaleReleaseAtBoot(() => undefined, current)).reload).toBe(false);
    const dev = boot(null, "index-New22222.js");
    expect(await checkStaleReleaseAtBoot(() => undefined, dev)).toEqual({
      reload: false,
      reason: "unknown",
    });
    expect(dev.fetch).not.toHaveBeenCalled();
  });

  it("respects the stale-reload kill switch", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "rum, stale-reload" });
    const page = boot("index-Old11111.js", "index-New22222.js");
    expect(await checkStaleReleaseAtBoot(() => undefined, page)).toEqual({
      reload: false,
      reason: "off",
    });
    expect(page.reload).not.toHaveBeenCalled();
    expect(page.fetch).not.toHaveBeenCalled();
  });
});
