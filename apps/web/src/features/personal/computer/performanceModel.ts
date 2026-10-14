/**
 * The Performance tab's pure half: thresholds with hysteresis, the summary
 * sentence, and the number formatting. No React, no DOM - the tests in
 * `performanceModel.test.ts` cover every row of the spec's threshold table
 * (SPEC-performance.md section 3) including the clearing values, so nothing
 * flickers at 89/91%.
 */
import type {
  PerformanceGroup,
  PerformanceGroups,
  PerformanceSample,
  PerformanceSlow,
  PerformanceStatics,
} from "@t3tools/contracts";

export type PerfWarnKey = "memory" | "cpu" | "cpuTemp" | "ssd" | "ram" | "disk" | "battery";

/** Which warnings are active right now; carried between ticks for hysteresis. */
export type PerfWarnState = Readonly<Record<PerfWarnKey, boolean>>;

export const NO_WARNINGS: PerfWarnState = {
  memory: false,
  cpu: false,
  cpuTemp: false,
  ssd: false,
  ram: false,
  disk: false,
  battery: false,
};

export interface PerformanceFeed {
  readonly samples: ReadonlyArray<PerformanceSample>;
  readonly groups: PerformanceGroups | null;
  readonly slow: PerformanceSlow | null;
  readonly statics: PerformanceStatics | null;
  /** When the last sample arrived (client clock), or null before the first. */
  readonly lastSampleAt: number | null;
  /** Bots working + thinking, from the app's own store. */
  readonly botsBusy: number;
  /** Tasks running, from the app's own store. */
  readonly tasksRunning: number;
}

export const PERF_STALE_AFTER_MS = 6_000;
/** How long the mean of a window is taken over. */
export const WINDOW_MS = 60_000;
const MEMORY_USABLE_GB_FALLBACK = 15.7;

const samplesSince = (
  samples: ReadonlyArray<PerformanceSample>,
  now: number,
  windowMs: number,
): ReadonlyArray<PerformanceSample> => samples.filter((sample) => now - sample.t <= windowMs);

const mean = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
};

const collect = (
  samples: ReadonlyArray<PerformanceSample>,
  pick: (sample: PerformanceSample) => number | null,
): ReadonlyArray<number> => {
  const out: number[] = [];
  for (const sample of samples) {
    const value = pick(sample);
    if (value !== null) out.push(value);
  }
  return out;
};

/** The mean of one field over the window, or null without any reading. */
export function meanOver(
  samples: ReadonlyArray<PerformanceSample>,
  now: number,
  windowMs: number,
  pick: (sample: PerformanceSample) => number | null,
): number | null {
  return mean(collect(samplesSince(samples, now, windowMs), pick));
}

/**
 * How long a condition has held, in ms: walked back from the newest sample
 * over the ones that still satisfy it. 0 when it does not hold right now.
 */
export function sustainedMs(
  samples: ReadonlyArray<PerformanceSample>,
  now: number,
  holds: (sample: PerformanceSample) => boolean,
): number {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  if (sorted.length === 0) return 0;
  const newest = sorted[sorted.length - 1]!;
  if (!holds(newest)) return 0;
  let oldest = newest.t;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const sample = sorted[i]!;
    if (!holds(sample)) break;
    oldest = sample.t;
  }
  return Math.max(0, now - oldest);
}

/**
 * The charts' fixed time axis (QA NO-SHIP, 13 Oct): 15 minutes of one slot per
 * sample tick, ending at the newest sample, so a sample's x is its own
 * timestamp. The first build plotted the samples back to back instead of by
 * time, so a stretch nobody watched squeezed together and two minutes of
 * samples stretched over the whole "15 min ago" to "Now" axis.
 */
export const PERF_AXIS_MS = 15 * 60_000;
/** The server's sample tick (`PERFORMANCE_TICK_MS` in the sampler). */
export const PERF_SLOT_MS = 2_000;
/** One slot per tick: what a full 15 minutes holds (the server's ring size). */
export const PERF_AXIS_SLOTS = PERF_AXIS_MS / PERF_SLOT_MS;
/** The axis spans the ticks between its edges, so the newest sample sits
 * exactly on the right edge instead of colliding with the one before it. */
const axisStart = (newestT: number): number => newestT - (PERF_AXIS_SLOTS - 1) * PERF_SLOT_MS;
/**
 * Consecutive samples more than this apart are a stretch nobody watched (the
 * spec's gap rule, about three sample intervals). The drawing breaks the line
 * there; a single missed tick inside one gap carries the previous reading.
 */
export const PERF_GAP_MS = 6_000;

const slotOf = (t: number, start: number): number =>
  Math.min(PERF_AXIS_SLOTS - 1, Math.max(0, Math.round((t - start) / PERF_SLOT_MS)));

/**
 * One value per slot on the fixed axis: each sample at its own timestamp,
 * samples older than the window dropped (they fall off the left edge), and
 * slots nobody sampled left null, so the chart leaves that stretch empty and
 * breaks its line there. Slots missed inside a gap of at most `PERF_GAP_MS`
 * take the previous reading, so one missed tick does not split the line.
 * `samples` is assumed oldest first, like the feed holds it.
 */
export function axisSeries(
  samples: ReadonlyArray<PerformanceSample>,
  newestT: number,
  pick: (sample: PerformanceSample) => number | null,
): ReadonlyArray<number | null> {
  const values: Array<number | null> = new Array(PERF_AXIS_SLOTS).fill(null);
  const start = axisStart(newestT);
  let previousSlot = -1;
  let previousT = 0;
  let previousValue: number | null = null;
  for (const sample of samples) {
    if (sample.t < start || sample.t > newestT) continue;
    const slot = slotOf(sample.t, start);
    const value = pick(sample);
    if (previousSlot >= 0 && slot - previousSlot > 1 && sample.t - previousT <= PERF_GAP_MS) {
      for (let i = previousSlot + 1; i < slot; i++) values[i] = previousValue;
    }
    values[slot] = value;
    previousSlot = slot;
    previousT = sample.t;
    previousValue = value;
  }
  return values;
}

/** True when every sample in the window holds a condition (and there is one). */
const heldThroughout = (
  samples: ReadonlyArray<PerformanceSample>,
  now: number,
  windowMs: number,
  holds: (sample: PerformanceSample) => boolean,
): boolean => {
  const window = samplesSince(samples, now, windowMs);
  const sorted = [...window].sort((a, b) => a.t - b.t);
  return sorted.length > 0 && sorted.every(holds);
};

export interface ThresholdInput {
  readonly samples: ReadonlyArray<PerformanceSample>;
  readonly slow: PerformanceSlow | null;
  readonly now: number;
  readonly previous: PerfWarnState;
}

export interface ThresholdResult {
  readonly state: PerfWarnState;
  /** The order warnings take in the summary (spec section 3). */
  readonly active: ReadonlyArray<PerfWarnKey>;
  /** Neutral words, no colour: "Busy" and "Warm". */
  readonly cpuBusy: boolean;
  readonly memoryBusy: boolean;
  readonly cpuWarm: boolean;
}

const memUsedPct = (samples: ReadonlyArray<PerformanceSample>, now: number): number | null => {
  const sample = samplesSince(samples, now, WINDOW_MS);
  const newest = sample[sample.length - 1];
  if (newest === undefined || newest.memUsedGB === null || newest.memTotalGB === null) return null;
  if (newest.memTotalGB <= 0) return null;
  return (newest.memUsedGB / newest.memTotalGB) * 100;
};

/**
 * The threshold table with enter and clear values, so a metric sitting at the
 * limit cannot flicker. "Sustained" means the mean of the window.
 */
export function evaluateThresholds(input: ThresholdInput): ThresholdResult {
  const { samples, now, previous, slow } = input;

  const cpuMean = meanOver(samples, now, WINDOW_MS, (sample) => sample.cpuPct);
  const cpu = previous.cpu ? cpuMean !== null && cpuMean >= 80 : cpuMean !== null && cpuMean >= 90;

  const usedPct = memUsedPct(samples, now);
  const usedPctMean = meanOver(samples, now, WINDOW_MS, (sample) => {
    if (sample.memUsedGB === null || sample.memTotalGB === null || sample.memTotalGB <= 0) {
      return null;
    }
    return (sample.memUsedGB / sample.memTotalGB) * 100;
  });
  const memory = previous.memory
    ? usedPct !== null && usedPct >= 85
    : usedPctMean !== null && usedPctMean >= 90;

  const tempMean = meanOver(samples, now, WINDOW_MS, (sample) => sample.cpuTempC);
  const hotHeld = heldThroughout(samples, now, 30_000, (sample) => (sample.cpuTempC ?? 0) >= 95);
  const clearHeld = heldThroughout(samples, now, 30_000, (sample) => (sample.cpuTempC ?? 0) < 90);
  const cpuTemp = previous.cpuTemp ? !clearHeld : hotHeld;

  const newestSsd = (() => {
    const window = samplesSince(samples, now, WINDOW_MS);
    const newest = window[window.length - 1];
    return newest?.ssdC ?? null;
  })();
  const ssd = previous.ssd
    ? newestSsd !== null && newestSsd >= 78
    : newestSsd !== null && newestSsd >= 82;

  const newestRam = (() => {
    const window = samplesSince(samples, now, WINDOW_MS);
    const newest = window[window.length - 1];
    return newest?.ramC ?? null;
  })();
  const ram = previous.ram
    ? newestRam !== null && newestRam >= 80
    : newestRam !== null && newestRam >= 85;

  const freeGB = slow?.diskFreeGB ?? null;
  const totalGB = slow?.diskTotalGB ?? null;
  const diskLow =
    freeGB !== null && totalGB !== null && totalGB > 0
      ? freeGB < 0.1 * totalGB || freeGB < 20
      : freeGB !== null
        ? freeGB < 20
        : false;
  const diskClear =
    freeGB !== null && totalGB !== null && totalGB > 0
      ? freeGB >= 0.12 * totalGB && freeGB >= 25
      : freeGB !== null
        ? freeGB >= 25
        : false;
  const disk = previous.disk ? !diskClear : diskLow;

  const batteryPct = slow?.batteryPct ?? null;
  const charging = slow?.batteryState === "charging" || slow?.batteryState === "full";
  const battery = previous.battery
    ? !(charging || (batteryPct !== null && batteryPct >= 20))
    : batteryPct !== null && batteryPct < 15 && !charging;

  const state: PerfWarnState = { memory, cpu, cpuTemp, ssd, ram, disk, battery };
  const active: PerfWarnKey[] = [];
  for (const key of ["memory", "cpu", "cpuTemp", "ssd", "ram", "disk", "battery"] as const) {
    if (state[key]) active.push(key);
  }

  const cpuBusy = cpuMean !== null && cpuMean >= 70;
  const memoryBusy = usedPctMean !== null && usedPctMean >= 80;
  const cpuWarm =
    !cpuTemp &&
    tempMean !== null &&
    tempMean >= 85 &&
    heldThroughout(samples, now, WINDOW_MS, (sample) => (sample.cpuTempC ?? 0) >= 85);

  return { state, active, cpuBusy, memoryBusy, cpuWarm };
}

export type PerfHeadline = "Measuring…" | "Paused" | "Under strain" | "Busy" | "Running smoothly";

export interface PerfSummary {
  readonly headline: PerfHeadline;
  /** The reason sentence, with the bolded parts (between \u0001 markers). */
  readonly reason: string;
  readonly stale: boolean;
  readonly loading: boolean;
}

export interface SummaryInput extends ThresholdResult {
  readonly samples: ReadonlyArray<PerformanceSample>;
  readonly groups: PerformanceGroups | null;
  readonly slow: PerformanceSlow | null;
  /** The newest sample's own time (server clock), for the durations. */
  readonly now: number;
  /**
   * Whether the feed has gone quiet. The caller decides it on ITS clock, so a
   * phone whose clock differs from the laptop's still flips at the right
   * moment; this function stays a pure function of its inputs.
   */
  readonly stale: boolean;
  /** When the newest sample arrived (client clock), for the paused copy. */
  readonly lastSampleAt: number | null;
  readonly botsBusy: number;
}

const fmtPct = (value: number): string => `${Math.round(value)}%`;
const fmtClock = (t: number, seconds = false): string => {
  const date = new Date(t);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return seconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
};

const fmtDuration = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} h`;
};

/** The group holding the biggest share, when it holds at least 30%. */
const mostly = (
  groups: PerformanceGroups | null,
  key: "cpu" | "mem",
  totalPct: number,
): PerformanceGroup | null => {
  const top = groups?.[key][0] ?? null;
  if (top === null || top.kind !== "bot") return null;
  if (totalPct <= 0 || top.cpuPct / totalPct < 0.3) return null;
  return top;
};

const bold = (text: string): string => `\u0001${text}\u0001`;

/** The newest sample without sorting a copy of the whole history. */
const sampleAtEnd = (samples: ReadonlyArray<PerformanceSample>): PerformanceSample | null => {
  let newest: PerformanceSample | null = null;
  for (const sample of samples) {
    if (newest === null || sample.t > newest.t) newest = sample;
  }
  return newest;
};

/** The summary card's words, first match wins (spec section 3). */
export function summaryFor(input: SummaryInput): PerfSummary {
  const { samples, groups, now, lastSampleAt, botsBusy, stale } = input;
  const newest = sampleAtEnd(samples);

  if (newest === null) {
    return {
      headline: "Measuring…",
      reason: "First numbers in a moment.",
      stale: false,
      loading: true,
    };
  }
  if (stale && lastSampleAt !== null) {
    return {
      headline: "Paused",
      reason: `No new numbers since ${fmtClock(lastSampleAt, true)}. They come back on their own.`,
      stale: true,
      loading: false,
    };
  }

  const cpuMean = meanOver(samples, now, WINDOW_MS, (sample) => sample.cpuPct);
  const usedPct = meanOver(samples, now, WINDOW_MS, (sample) => {
    if (sample.memUsedGB === null || sample.memTotalGB === null || sample.memTotalGB <= 0) {
      return null;
    }
    return (sample.memUsedGB / sample.memTotalGB) * 100;
  });
  const tempMean = meanOver(samples, now, WINDOW_MS, (sample) => sample.cpuTempC);
  const tempNow = newest.cpuTempC;

  for (const key of input.active) {
    switch (key) {
      case "memory": {
        const pct = usedPct ?? 0;
        const sustained = sustainedMs(samples, now, (sample) => {
          if (sample.memUsedGB === null || sample.memTotalGB === null || sample.memTotalGB <= 0) {
            return false;
          }
          return (sample.memUsedGB / sample.memTotalGB) * 100 >= 90;
        });
        const top = mostly(groups, "mem", newest.memUsedGB ?? 0);
        const suffix =
          top === null ? "" : `, mostly ${bold(top.name)} (${top.memGB.toFixed(1)} GB)`;
        return {
          headline: "Under strain",
          reason: `Memory over 90% for ${bold(fmtDuration(sustained || 30_000))}${suffix}.`,
          stale: false,
          loading: false,
        };
      }
      case "cpu": {
        const sustained = sustainedMs(samples, now, (sample) => (sample.cpuPct ?? 0) >= 90);
        const top = mostly(groups, "cpu", newest.cpuPct ?? 0);
        const suffix =
          top === null ? "" : `, mostly ${bold(top.name)} (${Math.round(top.cpuPct)}%)`;
        return {
          headline: "Under strain",
          reason: `CPU over 90% for ${bold(fmtDuration(sustained || 60_000))}${suffix}.`,
          stale: false,
          loading: false,
        };
      }
      case "cpuTemp":
        return {
          headline: "Under strain",
          reason: `CPU at ${bold(`${Math.round(tempNow ?? tempMean ?? 0)} °C`)}. It slows itself down at 100 °C.`,
          stale: false,
          loading: false,
        };
      case "ssd": {
        const ssd = newest.ssdC ?? 0;
        const crit = newest.ssdCritC ?? 89;
        return {
          headline: "Under strain",
          reason:
            ssd >= crit
              ? `SSD at ${bold(`${Math.round(ssd)} °C`)}. It slows itself down to cool off.`
              : `SSD at ${bold(`${Math.round(ssd)} °C`)}, over its ${Math.round(newest.ssdWarnC ?? 82)} °C limit.`,
          stale: false,
          loading: false,
        };
      }
      case "ram":
        return {
          headline: "Under strain",
          reason: `Memory chips at ${bold(`${Math.round(newest.ramC ?? 0)} °C`)}.`,
          stale: false,
          loading: false,
        };
      case "disk":
        return {
          headline: "Under strain",
          reason: `Drive C: has ${bold(`${Math.round(input.slow?.diskFreeGB ?? 0)} GB`)} free.`,
          stale: false,
          loading: false,
        };
      case "battery":
        return {
          headline: "Under strain",
          reason: `Battery ${bold(`${Math.round(input.slow?.batteryPct ?? 0)}%`)} and not charging.`,
          stale: false,
          loading: false,
        };
    }
  }

  if (input.cpuBusy && cpuMean !== null) {
    const top = mostly(groups, "cpu", newest.cpuPct ?? 0);
    const suffix = top === null ? "" : `, mostly ${bold(top.name)}`;
    return {
      headline: "Busy",
      reason: `CPU ${bold(fmtPct(cpuMean))} for the last minute${suffix}.`,
      stale: false,
      loading: false,
    };
  }
  if (input.memoryBusy && usedPct !== null) {
    return {
      headline: "Busy",
      reason: `Memory ${bold(fmtPct(usedPct))} used.`,
      stale: false,
      loading: false,
    };
  }
  if (input.cpuWarm && tempMean !== null) {
    return {
      headline: "Busy",
      reason: `CPU warm at ${bold(`${Math.round(tempMean)} °C`)}.`,
      stale: false,
      loading: false,
    };
  }

  const share = newest.cpuPct;
  return {
    headline: "Running smoothly",
    reason:
      botsBusy === 0
        ? "No bots busy."
        : `${bold(String(botsBusy))} ${botsBusy === 1 ? "bot" : "bots"} busy${share === null ? "" : `, using ${bold(fmtPct(share))} of the CPU`}.`,
    stale: false,
    loading: false,
  };
}

/** The calm pill a card shows while its own threshold is active. */
export function warnPill(
  key: PerfWarnKey,
  state: { readonly active: ReadonlyArray<PerfWarnKey> },
  sample: PerformanceSample | null,
): string | null {
  if (!state.active.includes(key)) return null;
  switch (key) {
    case "cpu":
      return "Over 90%";
    case "cpuTemp":
      return "Hot";
    case "ssd":
      return "Over its limit";
    case "ram":
      return "Hot";
    case "disk":
      return "Almost full";
    case "battery":
      return "Low, not charging";
    case "memory":
      return sample?.memUsedGB !== null && sample !== null && sample.memTotalGB !== null
        ? "Over 90%"
        : "Almost full";
  }
}

/** A number for the eye; nulls read as an en dash. */
export function fmt(value: number | null, digits = 0, suffix = ""): string {
  if (value === null) return "–";
  return `${digits === 0 ? Math.round(value).toLocaleString("en-GB") : value.toFixed(digits)}${suffix}`;
}

export { fmtClock, fmtDuration, fmtPct };
