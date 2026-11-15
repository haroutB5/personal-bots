import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => ({
  value: null as string | null,
  fail: false,
  reads: 0,
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => {
    store.reads += 1;
    if (store.fail) throw new Error("keystore");
    return store.value;
  },
  setItemAsync: async (_key: string, value: string) => {
    store.value = value;
  },
}));

import {
  currentSeenAt,
  ensureSeenAtLoaded,
  resetSeenAtForTests,
  saveSeenAt,
  seenAtIsLoaded,
  subscribeSeenAt,
} from "./seenAt";

const MARKER = "2026-11-14T10:40:00.000Z";

describe("the Work tab seen marker", () => {
  beforeEach(() => {
    resetSeenAtForTests();
    store.value = null;
    store.fail = false;
    store.reads = 0;
  });

  it("reads the saved server time once and tells subscribers", async () => {
    store.value = MARKER;
    expect(currentSeenAt()).toBeNull();
    expect(seenAtIsLoaded()).toBe(false);
    const heard: Array<string | null> = [];
    subscribeSeenAt(() => heard.push(currentSeenAt()));

    expect(await ensureSeenAtLoaded()).toBe(MARKER);
    expect(seenAtIsLoaded()).toBe(true);
    expect(currentSeenAt()).toBe(MARKER);
    expect(heard).toEqual([MARKER]);

    expect(await ensureSeenAtLoaded()).toBe(MARKER);
    expect(store.reads).toBe(1);
  });

  it("treats a failed or damaged read as the first run", async () => {
    store.fail = true;
    expect(await ensureSeenAtLoaded()).toBeNull();
    expect(seenAtIsLoaded()).toBe(true);

    resetSeenAtForTests();
    store.fail = false;
    store.value = "not-a-date";
    expect(await ensureSeenAtLoaded()).toBeNull();
  });

  it("publishes a saved marker before the write finishes", async () => {
    await saveSeenAt(MARKER);
    expect(currentSeenAt()).toBe(MARKER);
    expect(seenAtIsLoaded()).toBe(true);
    expect(store.value).toBe(MARKER);
  });
});
