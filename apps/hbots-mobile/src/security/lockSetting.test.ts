import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => ({ value: null as string | null, fail: false }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => {
    if (store.fail) throw new Error("keystore");
    return store.value;
  },
  setItemAsync: async (_key: string, value: string) => {
    store.value = value;
  },
}));

import { LOCK_OFF, serializeLock } from "./appLock";
import {
  currentLock,
  loadLock,
  lockIsLoaded,
  resetLockForTests,
  saveLock,
  subscribeLock,
} from "./lockSetting";

describe("the saved lock setting", () => {
  beforeEach(() => {
    resetLockForTests();
    store.value = null;
    store.fail = false;
  });

  it("reads as Off but not loaded until the first read finishes", async () => {
    store.value = serializeLock({ kind: "on", timeout: "immediate" });
    expect(currentLock()).toEqual(LOCK_OFF);
    expect(lockIsLoaded()).toBe(false);
    const heard: boolean[] = [];
    subscribeLock(() => heard.push(lockIsLoaded()));
    const loaded = await loadLock();
    expect(lockIsLoaded()).toBe(true);
    expect(loaded.kind).toBe("on");
    // The listener hears the change only after the flag is set, so a sync it triggers sees the real lock.
    expect(heard).toEqual([true]);
  });

  it("counts a failed read as loaded and Off", async () => {
    store.fail = true;
    await loadLock();
    expect(lockIsLoaded()).toBe(true);
    expect(currentLock()).toEqual(LOCK_OFF);
  });

  it("counts a choice made this run as loaded", async () => {
    await saveLock({ kind: "on", timeout: "immediate" } as const);
    expect(lockIsLoaded()).toBe(true);
  });
});
