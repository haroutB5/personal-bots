import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parsePhoneSystemSummary, type PhoneSystemSummary } from "./serverStats";
import { startSummaryPoller } from "./systemSummaryPoller";

const summary = (server?: unknown, serverApps?: unknown): PhoneSystemSummary => {
  const parsed = parsePhoneSystemSummary({ cpuPct: 5, server, serverApps });
  if (parsed === null) throw new Error("fixture");
  return parsed;
};

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

describe("startSummaryPoller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (reads: Array<PhoneSystemSummary | null>, active = true) => {
    const read = vi.fn(async () => reads.shift() ?? null);
    const seen: PhoneSystemSummary[] = [];
    const poller = startSummaryPoller({
      read,
      onSummary: (next) => seen.push(next),
      initiallyActive: active,
    });
    return { read, seen, poller };
  };

  it("asks at once, then every 10 s", async () => {
    const { read, poller } = setup([summary(), summary(), summary()]);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it.each([
    ["the server stats link", [{ state: "starting" }, undefined]],
    ["the Coolify app health", [undefined, { state: "starting" }]],
  ] as const)("asks again after 3 s while %s is starting", async (_name, [server, apps]) => {
    const { read, poller } = setup([summary(server, apps), summary()]);
    await flush();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("keeps 10 s once Coolify answered, even when it is unreachable", async () => {
    const { read, poller } = setup([summary(undefined, { state: "unreachable" }), summary()]);
    await flush();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(read).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("retries after 30 s when a read fails and keeps the last summary", async () => {
    const good = summary();
    const { read, seen, poller } = setup([good, null, good]);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(seen).toHaveLength(2);
    poller.stop();
  });

  it("pauses in the background and asks at once on return", async () => {
    const { read, poller } = setup([summary(), summary(), summary()]);
    await flush();
    poller.appStateChanged(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    poller.appStateChanged(true);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("does not start while the app is in the background", async () => {
    const { read, poller } = setup([summary()], false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).not.toHaveBeenCalled();
    poller.appStateChanged(true);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("does not schedule when the app went to the background during a read", async () => {
    let finish: (value: PhoneSystemSummary | null) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<PhoneSystemSummary | null>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = startSummaryPoller({ read, onSummary: () => {}, initiallyActive: true });
    await flush();
    poller.appStateChanged(false);
    finish(summary());
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it("never runs two reads at once", async () => {
    let finish: (value: PhoneSystemSummary | null) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise<PhoneSystemSummary | null>((resolve) => {
          finish = resolve;
        }),
    );
    const poller = startSummaryPoller({ read, onSummary: () => {}, initiallyActive: true });
    await flush();
    poller.appStateChanged(false);
    poller.appStateChanged(true);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    finish(summary());
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("stops for good: no timers, no late summary", async () => {
    const { read, seen, poller } = setup([summary(), summary()]);
    await flush();
    poller.stop();
    poller.appStateChanged(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
