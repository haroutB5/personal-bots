import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { installRouterChunkReloadGuard } from "./routerChunkReloadGuard";

/** A stand-in for the browser's Storage whose prototype the guard patches. */
class FakeStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("the router's reload for a missing route chunk", () => {
  const routerKey =
    "tanstack_router_reload:Failed to fetch dynamically imported module: /assets/a.js";

  it("is told it already reloaded while the server looks unreachable, so it throws instead of reloading", () => {
    vi.stubGlobal("Storage", FakeStorage);
    let away = true;
    installRouterChunkReloadGuard(() => away);
    const storage = new FakeStorage();
    expect(storage.getItem(routerKey)).toBe("1");
    away = false;
    expect(storage.getItem(routerKey)).toBeNull();
  });

  it("leaves every other key alone, even while away", () => {
    vi.stubGlobal("Storage", FakeStorage);
    installRouterChunkReloadGuard(() => true);
    const storage = new FakeStorage();
    storage.setItem("t3code:chunk-load-reloaded", "1");
    expect(storage.getItem("t3code:chunk-load-reloaded")).toBe("1");
    expect(storage.getItem("anything else")).toBeNull();
  });

  it("does nothing where there is no Storage", () => {
    vi.stubGlobal("Storage", undefined);
    expect(() => installRouterChunkReloadGuard(() => true)).not.toThrow();
  });
});
