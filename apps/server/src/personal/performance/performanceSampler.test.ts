import { describe, expect, it, vi } from "vite-plus/test";

import type { PerformanceStatics, PerformanceStreamEvent } from "@t3tools/contracts";

import { parseHelperTick, type HelperChild } from "./counterSample.ts";
import { PerformanceSampler, type HelperHandle } from "./performanceSampler.ts";
import { SENSORS_DOWN, type SensorsReading } from "./sensors.ts";

const STATICS: PerformanceStatics = {
  pcModel: null,
  pcCpu: null,
  pcCores: null,
  pcThreads: null,
  pcGpu: null,
  ramGB: null,
  pcBootAt: null,
  hbotsVersion: "1.67.2",
  hbotsStartedAt: 1_000,
};

const tickLine = (t: number, withGroups: boolean) =>
  '{"t":' +
  t +
  ',"ms":9,"c":{"cpuUtility":12.5,"cpuPerformance":100,"memAvailableMB":8000,' +
  '"diskIdlePct":90,"diskReadBps":0,"diskWriteBps":0,"threads":[' +
  Array.from({ length: 20 }, (_, i) => `["0,${i}",1]`).join(",") +
  '],"gpu":[],"netRx":[["Wi-Fi",100]],"netTx":[["Wi-Fi",50]],"proc":[["node",1,1,10]]},' +
  '"k":[]' +
  (withGroups
    ? ',"pp":[[10,999,1]]' +
      ',"s":{"batteryPct":90,"batteryState":"discharging","batteryMinutesLeft":120,"diskTotalGB":512,"diskFreeGB":100}'
    : "") +
  "}";

/** A fake helper whose lines the test pushes by hand. */
const fakeHelper = () => {
  let onLine: (line: string) => void = () => undefined;
  let onExit: () => void = () => undefined;
  const killed = { value: false };
  const handle: HelperHandle = {
    pid: 4242,
    onLine: (listener) => {
      onLine = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
    kill: () => {
      killed.value = true;
    },
  };
  return { handle, killed, push: (line: string) => onLine(line), exit: () => onExit() };
};

const reading = (): SensorsReading => SENSORS_DOWN;

const make = (
  overrides: Partial<ConstructorParameters<typeof PerformanceSampler>[0]> = {},
  helper = fakeHelper(),
) => {
  let clock = 1_000_000;
  const sampler = new PerformanceSampler({
    platform: "win32",
    now: () => clock,
    serverPid: 999,
    startHelper: () => helper.handle,
    readSensors: reading,
    readStatics: () => STATICS,
    log: () => undefined,
    ...overrides,
  });
  return {
    sampler,
    helper,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

describe("PerformanceSampler lifecycle", () => {
  it("starts the helper and the tick on the first viewer, stops both after the grace", async () => {
    vi.useFakeTimers();
    try {
      const helper = fakeHelper();
      const startHelper = vi.fn(() => helper.handle);
      const { sampler, advance } = make({ startHelper }, helper);

      expect(sampler.state().running).toBe(false);
      const subscription = sampler.subscribe(() => undefined);
      expect(startHelper).toHaveBeenCalledTimes(1);
      expect(sampler.state().running).toBe(true);
      expect(sampler.state().viewers).toBe(1);
      expect(subscription.hello.kind).toBe("hello");

      await vi.advanceTimersByTimeAsync(2_000);
      advance(2_000);
      expect(sampler.historyForTest().length).toBe(1);

      subscription.unsubscribe();
      expect(sampler.state().viewers).toBe(0);
      // Inside the grace the sampler still runs; after it, everything stops.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(sampler.state().running).toBe(true);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(sampler.state().running).toBe(false);
      expect(helper.killed.value).toBe(true);
      expect(sampler.state().helperPid).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the history across a reload: unsubscribe and resubscribe share the ring", async () => {
    vi.useFakeTimers();
    try {
      const { sampler, advance } = make({}, fakeHelper());
      const first = sampler.subscribe(() => undefined);
      first.hello;
      await vi.advanceTimersByTimeAsync(2_000);
      advance(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      advance(2_000);
      first.unsubscribe();
      // A reload comes back inside the grace: no stop, history intact.
      await vi.advanceTimersByTimeAsync(1_000);
      const second = sampler.subscribe(() => undefined);
      expect(second.hello.kind).toBe("hello");
      if (second.hello.kind === "hello") {
        expect(second.hello.history.length).toBe(2);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the ring at its size", async () => {
    vi.useFakeTimers();
    try {
      const { sampler, advance } = make({ historySize: 3 }, fakeHelper());
      const subscription = sampler.subscribe(() => undefined);
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(2_000);
        advance(2_000);
      }
      expect(sampler.historyForTest().length).toBe(3);
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits groups every other tick, from the helper's parent map", async () => {
    vi.useFakeTimers();
    try {
      const helper = fakeHelper();
      const { sampler, advance } = make({ startHelper: () => helper.handle }, helper);
      const events: PerformanceStreamEvent[] = [];
      const subscription = sampler.subscribe((event) => events.push(event));
      helper.push(tickLine(1_000_000, false));
      await vi.advanceTimersByTimeAsync(2_000);
      advance(2_000);
      expect(events.filter((event) => event.kind === "groups").length).toBe(0);
      helper.push(tickLine(1_002_000, true));
      await vi.advanceTimersByTimeAsync(2_000);
      advance(2_000);
      const groups = events.filter((event) => event.kind === "groups");
      expect(groups.length).toBe(1);
      const samples = events.filter((event) => event.kind === "sample");
      expect(samples.length).toBe(2);
      if (samples[0]?.kind === "sample") {
        expect(samples[0].sample.cpuPct).toBe(12.5);
        expect(samples[0].sample.memFreeGB).toBeCloseTo(7.8, 1);
      }
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a helper on a platform without one, and falls back to os numbers", async () => {
    vi.useFakeTimers();
    try {
      const startHelper = vi.fn(() => null as never);
      const { sampler, advance } = make({ platform: "linux", startHelper }, fakeHelper());
      const subscription = sampler.subscribe(() => undefined);
      expect(startHelper).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      advance(2_000);
      const sample = sampler.lastSampleForTest();
      expect(sample).not.toBeNull();
      expect(sample?.memTotalGB).not.toBeNull();
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the hbots share between group refreshes and drops stale counters", async () => {
    vi.useFakeTimers();
    try {
      const helper = fakeHelper();
      const { sampler, advance } = make({ startHelper: () => helper.handle }, helper);
      sampler.subscribe(() => undefined);
      helper.push(tickLine(1_000_000, false));
      await vi.advanceTimersByTimeAsync(2_000);
      advance(2_000);
      expect(sampler.lastSampleForTest()?.cpuPct).toBe(12.5);
      // The helper goes quiet for longer than a tick: the counters go null.
      advance(20_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sampler.lastSampleForTest()?.cpuPct).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseHelperTick sanity for the sampler fixture", () => {
  it("parses the line the sampler tests push", () => {
    const tick = parseHelperTick(tickLine(1_000_000, true));
    expect(tick?.cpuUtility).toBe(12.5);
    expect(tick?.slow?.batteryState).toBe("discharging");
    expect(tick?.parents?.length).toBe(1);
  });
});

describe("child attribution input", () => {
  it("the sampler asks for attribution with the helper's children", async () => {
    vi.useFakeTimers();
    try {
      const helper = fakeHelper();
      const attribute = vi.fn(async (_children: ReadonlyArray<HelperChild>) => new Map());
      const { sampler, advance } = make({ startHelper: () => helper.handle, attribute }, helper);
      sampler.subscribe(() => undefined);
      helper.push(tickLine(1_000_000, true));
      await vi.advanceTimersByTimeAsync(2_000);
      advance(2_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(attribute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
