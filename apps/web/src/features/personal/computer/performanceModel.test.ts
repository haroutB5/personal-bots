import { describe, expect, it } from "vite-plus/test";

import type { PerformanceGroups, PerformanceSample, PerformanceSlow } from "@t3tools/contracts";

import {
  evaluateThresholds,
  meanOver,
  NO_WARNINGS,
  summaryFor,
  sustainedMs,
  type PerfWarnState,
  type ThresholdResult,
} from "./performanceModel";

const NOW = 20 * 3_600_000 + 41 * 60_000;

/** A full sample with everything calm; override one field at a time. */
const sample = (overrides: Partial<PerformanceSample> = {}): PerformanceSample => ({
  t: NOW,
  cpuPct: 12,
  clockGHz: 3.1,
  threadPct: null,
  memUsedGB: 9.8,
  memFreeGB: 5.9,
  memTotalGB: 15.7,
  hbotsPct: 7,
  hbotsGB: 2.9,
  gpuPct: 12,
  gpuEngine: "3D",
  diskActivePct: 4,
  diskReadMBps: 1.2,
  diskWriteMBps: 0.4,
  netDownMbps: 12.4,
  netUpMbps: 1.1,
  netAdapter: "Wi-Fi",
  cpuTempC: 64,
  pCoreC: null,
  eCoreC: null,
  ssdC: 41,
  ssdWarnC: 82,
  ssdCritC: 89,
  ramC: 46,
  powerCpuW: 15,
  powerGpuW: 1.2,
  powerPlatformW: 27,
  batteryRateW: 38,
  fan1Rpm: 2801,
  fan2Rpm: 2667,
  fanStatus: "ok",
  lhm: "ok",
  fans: "ok",
  ...overrides,
});

/**
 * A history of samples every 2 s ending at NOW: `overrides` applies to the
 * newest `count` samples (for a sustained reading), every earlier one is calm.
 */
const history = (
  overrides: Partial<PerformanceSample>,
  count = 31,
  spanMs = 60_000,
): ReadonlyArray<PerformanceSample> => {
  const step = 2_000;
  const total = Math.floor(spanMs / step) + 1;
  const out: PerformanceSample[] = [];
  for (let i = 0; i < total; i++) {
    const t = NOW - (total - 1 - i) * step;
    out.push(i >= total - count ? sample({ ...overrides, t }) : sample({ t }));
  }
  return out;
};

const evaluate = (
  samples: ReadonlyArray<PerformanceSample>,
  slow: PerformanceSlow | null = null,
  previous: PerfWarnState = NO_WARNINGS,
): ThresholdResult => evaluateThresholds({ samples, slow, now: NOW, previous });

const slow = (overrides: Partial<PerformanceSlow> = {}): PerformanceSlow => ({
  t: NOW,
  batteryPct: 64,
  batteryState: "charging",
  batteryMinutesLeft: 55,
  batteryDesignWh: 86,
  batteryFullWh: 74,
  diskTotalGB: 476,
  diskFreeGB: 77,
  dataGB: 7,
  backupsGB: 37,
  backupsCount: 18,
  releasesGB: 8,
  ...overrides,
});

describe("evaluateThresholds", () => {
  it("stays calm well under every threshold", () => {
    const result = evaluate(history({}));
    expect(result.active).toEqual([]);
    expect(result.cpuBusy).toBe(false);
    expect(result.memoryBusy).toBe(false);
    expect(result.cpuWarm).toBe(false);
  });

  it("CPU: busy word at a 60 s mean of 70, warn at 90, clears under 80", () => {
    const busy = evaluate(history({ cpuPct: 75 }));
    expect(busy.cpuBusy).toBe(true);
    expect(busy.state.cpu).toBe(false);

    const hot = evaluate(history({ cpuPct: 96 }));
    expect(hot.state.cpu).toBe(true);
    expect(hot.active).toContain("cpu");

    // Once active, 85 keeps it active (no flicker) until the mean drops under 80.
    const still = evaluate(history({ cpuPct: 85 }), null, { ...NO_WARNINGS, cpu: true });
    expect(still.state.cpu).toBe(true);
    const cleared = evaluate(history({ cpuPct: 78 }), null, { ...NO_WARNINGS, cpu: true });
    expect(cleared.state.cpu).toBe(false);
    // And 89 is not enough to enter from calm.
    expect(evaluate(history({ cpuPct: 89 })).state.cpu).toBe(false);
  });

  it("Memory: warn at 90% of usable, clears under 85%, busy word at 80%", () => {
    const high = history({ memUsedGB: 14.4 }); // 91.7% of 15.7
    const warned = evaluate(high);
    expect(warned.state.memory).toBe(true);

    const mid = history({ memUsedGB: 13.6 }); // 86.6%
    expect(evaluate(mid).state.memory).toBe(false);
    expect(evaluate(mid, null, { ...NO_WARNINGS, memory: true }).state.memory).toBe(true);
    expect(
      evaluate(history({ memUsedGB: 13.2 }), null, { ...NO_WARNINGS, memory: true }).state.memory,
    ).toBe(false); // 84.1%
    expect(evaluate(history({ memUsedGB: 12.9 })).memoryBusy).toBe(true); // 82%
  });

  it("CPU temp: warm word at 85, hot at 95 for 30 s, clears under 90 for 30 s", () => {
    const warm = evaluate(history({ cpuTempC: 87 }));
    expect(warm.cpuWarm).toBe(true);
    expect(warm.state.cpuTemp).toBe(false);

    const hot = evaluate(history({ cpuTempC: 96 }, 16)); // 16 samples = 31 s
    expect(hot.state.cpuTemp).toBe(true);

    // Active and steady at 92: still active (clear needs 30 s under 90).
    const still = evaluate(history({ cpuTempC: 92 }, 16), null, { ...NO_WARNINGS, cpuTemp: true });
    expect(still.state.cpuTemp).toBe(true);
    // 30 s under 90 clears it.
    const cleared = evaluate(history({ cpuTempC: 88 }, 16), null, {
      ...NO_WARNINGS,
      cpuTemp: true,
    });
    expect(cleared.state.cpuTemp).toBe(false);
    // A single hot reading is not enough to enter.
    expect(evaluate(history({ cpuTempC: 96 }, 3)).state.cpuTemp).toBe(false);
  });

  it("SSD warns at 82 and clears under 78; RAM warns at 85 and clears under 80", () => {
    expect(evaluate(history({ ssdC: 83 })).state.ssd).toBe(true);
    expect(evaluate(history({ ssdC: 79 }), null, { ...NO_WARNINGS, ssd: true }).state.ssd).toBe(
      true,
    );
    expect(evaluate(history({ ssdC: 77 }), null, { ...NO_WARNINGS, ssd: true }).state.ssd).toBe(
      false,
    );

    expect(evaluate(history({ ramC: 86 })).state.ram).toBe(true);
    expect(evaluate(history({ ramC: 82 }), null, { ...NO_WARNINGS, ram: true }).state.ram).toBe(
      true,
    );
    expect(evaluate(history({ ramC: 79 }), null, { ...NO_WARNINGS, ram: true }).state.ram).toBe(
      false,
    );
  });

  it("Disk warns under 10% or 20 GB, and clears at 12% and 25 GB", () => {
    expect(evaluate(history({}), slow({ diskFreeGB: 18 })).state.disk).toBe(true);
    expect(evaluate(history({}), slow({ diskFreeGB: 40, diskTotalGB: 476 })).state.disk).toBe(true); // 8.4%
    const active = { ...NO_WARNINGS, disk: true };
    // Clears only at both 12% of the drive and 25 GB: 26 GB of 476 is 5.5%.
    expect(evaluate(history({}), slow({ diskFreeGB: 26 }), active).state.disk).toBe(true);
    expect(evaluate(history({}), slow({ diskFreeGB: 60 }), active).state.disk).toBe(false);
  });

  it("Battery warns under 15% while not charging, clears when charging or at 20%", () => {
    expect(
      evaluate(history({}), slow({ batteryPct: 12, batteryState: "discharging" })).state.battery,
    ).toBe(true);
    // Plugged in but not charging yet: still low.
    expect(
      evaluate(history({}), slow({ batteryPct: 12, batteryState: "plugged" })).state.battery,
    ).toBe(true);
    expect(
      evaluate(history({}), slow({ batteryPct: 12, batteryState: "charging" })).state.battery,
    ).toBe(false);
    const active = { ...NO_WARNINGS, battery: true };
    expect(
      evaluate(history({}), slow({ batteryPct: 22, batteryState: "discharging" }), active).state
        .battery,
    ).toBe(false);
  });

  it("orders active warnings as the summary needs them", () => {
    const result = evaluate(history({ cpuPct: 96, memUsedGB: 14.4, ssdC: 84 }));
    expect(result.active).toEqual(["memory", "cpu", "ssd"]);
  });
});

describe("summaryFor", () => {
  const calm = evaluate(history({}));
  const base = {
    samples: history({}),
    groups: null,
    slow: null,
    now: NOW,
    stale: false,
    lastSampleAt: NOW,
    botsBusy: 3,
  };

  it("measures before the first number", () => {
    const empty = evaluateThresholds({ samples: [], slow: null, now: NOW, previous: NO_WARNINGS });
    const summary = summaryFor({
      ...base,
      ...empty,
      samples: [],
      lastSampleAt: null,
      stale: false,
    });
    expect(summary.headline).toBe("Measuring…");
    expect(summary.loading).toBe(true);
  });

  it("pauses when the numbers stop", () => {
    const summary = summaryFor({ ...base, ...calm, stale: true, lastSampleAt: NOW - 8_000 });
    expect(summary.headline).toBe("Paused");
    expect(summary.reason).toContain("No new numbers since");
  });

  it("says running smoothly, with the bots busy count", () => {
    const summary = summaryFor({ ...base, ...calm });
    expect(summary.headline).toBe("Running smoothly");
    expect(summary.reason).toBe("\u00013\u0001 bots busy, using \u000112%\u0001 of the CPU.");
    expect(summaryFor({ ...base, ...calm, botsBusy: 0 }).reason).toBe("No bots busy.");
  });

  it("says Busy with the reason, without colour", () => {
    const samples = history({ cpuPct: 78 });
    const busy = evaluate(samples);
    const summary = summaryFor({ ...base, ...busy, samples });
    expect(summary.headline).toBe("Busy");
    expect(summary.reason).toBe("CPU \u000178%\u0001 for the last minute.");
  });

  it("says Under strain for the first active warning, memory before cpu", () => {
    const samples = history({ memUsedGB: 14.4, cpuPct: 96 });
    const strained = evaluate(samples);
    const summary = summaryFor({ ...base, ...strained, samples });
    expect(summary.headline).toBe("Under strain");
    expect(summary.reason).toContain("Memory over 90%");
  });

  it("names the busiest bot when it holds at least 30% of the load", () => {
    const groups: PerformanceGroups = {
      t: NOW,
      cpu: [
        { name: "Forge", kind: "bot", botId: "bot-forge", processCount: 4, cpuPct: 41, memGB: 0.5 },
      ],
      mem: [
        {
          name: "Google Chrome",
          kind: "app",
          botId: null,
          processCount: 22,
          cpuPct: 3.4,
          memGB: 2.1,
        },
      ],
      hbots: {
        server: {
          name: "hbots server",
          kind: "hbots",
          botId: null,
          processCount: 1,
          cpuPct: 1,
          memGB: 0.8,
        },
        bots: {
          name: "Bots",
          kind: "hbots",
          botId: null,
          processCount: 10,
          cpuPct: 3.7,
          memGB: 1.3,
        },
        browser: {
          name: "Bots' browser",
          kind: "hbots",
          botId: null,
          processCount: 9,
          cpuPct: 2.3,
          memGB: 0.8,
        },
        total: {
          name: "Total",
          kind: "hbots",
          botId: null,
          processCount: 20,
          cpuPct: 7,
          memGB: 2.9,
        },
      },
    };
    const samples = history({ cpuPct: 96 });
    const strained = evaluate(samples);
    const summary = summaryFor({ ...base, ...strained, samples, groups });
    expect(summary.reason).toContain("mostly \u0001Forge\u0001 (41%)");

    // Under 30% of the total, the name is left out.
    const small = {
      ...groups,
      cpu: [{ ...groups.cpu[0]!, cpuPct: 20 }],
    };
    const quiet = summaryFor({ ...base, ...strained, samples, groups: small });
    expect(quiet.reason).not.toContain("mostly");
  });
});

describe("helpers", () => {
  it("meanOver only counts the window", () => {
    const samples = [
      sample({ t: NOW - 120_000, cpuPct: 100 }),
      sample({ t: NOW - 2_000, cpuPct: 10 }),
    ];
    expect(meanOver(samples, NOW, 60_000, (s) => s.cpuPct)).toBe(10);
  });

  it("sustainedMs walks back over the holding samples", () => {
    const samples = [
      sample({ t: NOW - 10_000, cpuPct: 95 }),
      sample({ t: NOW - 8_000, cpuPct: 95 }),
      sample({ t: NOW - 6_000, cpuPct: 30 }),
      sample({ t: NOW - 4_000, cpuPct: 95 }),
      sample({ t: NOW - 2_000, cpuPct: 95 }),
    ];
    expect(sustainedMs(samples, NOW, (s) => (s.cpuPct ?? 0) >= 90)).toBe(4_000);
    expect(sustainedMs(samples, NOW, () => false)).toBe(0);
  });
});
