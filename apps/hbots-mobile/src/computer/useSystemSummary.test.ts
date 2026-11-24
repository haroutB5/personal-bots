import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => undefined }),
  },
}));

import { parsePhoneSystemSummary, type PhoneSystemSummary } from "./serverStats";
import { createSystemSummaryRegistry, type SummaryStoreSource } from "./useSystemSummary";

const summary = (cpuPct: number): PhoneSystemSummary => {
  const parsed = parsePhoneSystemSummary({ cpuPct });
  if (parsed === null) throw new Error("fixture");
  return parsed;
};

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("createSystemSummaryRegistry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const makeAppState = (initiallyActive = true) => {
    let active = initiallyActive;
    const listeners = new Set<(next: boolean) => void>();
    return {
      api: {
        isActive: () => active,
        subscribe: (onChange: (next: boolean) => void) => {
          listeners.add(onChange);
          return () => {
            listeners.delete(onChange);
          };
        },
      },
      setActive: (next: boolean) => {
        active = next;
        for (const listener of listeners) listener(next);
      },
      listenerCount: () => listeners.size,
    };
  };

  it("shares one poller across multiple subscribers and serves cached snapshot to late mounts", async () => {
    const appState = makeAppState(true);
    const registry = createSystemSummaryRegistry(appState.api);
    const reads = [summary(12), summary(24)];
    const source: SummaryStoreSource = {
      readSystemSummary: vi.fn(async () => reads.shift() ?? null),
    };

    const seenA: Array<PhoneSystemSummary | null> = [];
    const seenB: Array<PhoneSystemSummary | null> = [];

    const unsubA = registry.subscribe(source, (next) => seenA.push(next));
    await flush();

    expect(source.readSystemSummary).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot(source)?.cpuPct).toBe(12);

    // Second subscriber mounts: immediately gets cached snapshot without spawning a second poller.
    expect(registry.getSnapshot(source)?.cpuPct).toBe(12);
    const unsubB = registry.subscribe(source, (next) => seenB.push(next));
    await flush();
    expect(source.readSystemSummary).toHaveBeenCalledTimes(1);
    expect(appState.listenerCount()).toBe(1);

    // Next 10 s tick updates both subscribers from a single fetch.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.readSystemSummary).toHaveBeenCalledTimes(2);
    expect(seenA.map((s) => s?.cpuPct)).toEqual([12, 24]);
    expect(seenB.map((s) => s?.cpuPct)).toEqual([24]);

    // Unsubscribing one keeps the poller alive for the other.
    unsubA();
    expect(appState.listenerCount()).toBe(1);

    // Unsubscribing the last stops the poller and removes the AppState listener, keeping cache.
    unsubB();
    expect(appState.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(registry.getSnapshot(source)?.cpuPct).toBe(24);
  });

  it("isolates stores by source instance and pauses on background", async () => {
    const appState = makeAppState(true);
    const registry = createSystemSummaryRegistry(appState.api);
    const sourceA: SummaryStoreSource = {
      readSystemSummary: vi.fn(async () => summary(10)),
    };
    const sourceB: SummaryStoreSource = {
      readSystemSummary: vi.fn(async () => summary(80)),
    };

    const unsubA = registry.subscribe(sourceA, () => undefined);
    const unsubB = registry.subscribe(sourceB, () => undefined);
    await flush();

    expect(registry.getSnapshot(sourceA)?.cpuPct).toBe(10);
    expect(registry.getSnapshot(sourceB)?.cpuPct).toBe(80);

    appState.setActive(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sourceA.readSystemSummary).toHaveBeenCalledTimes(1);
    expect(sourceB.readSystemSummary).toHaveBeenCalledTimes(1);

    unsubA();
    unsubB();
  });
});
