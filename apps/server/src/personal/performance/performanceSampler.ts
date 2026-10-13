// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
/**
 * The one sampler behind Computer > Performance.
 *
 * Lifecycle (the brief's perf rules): nothing at all runs while nobody has
 * the tab open. The first viewer writes the helper script, starts the
 * long-lived counter helper and the 2 s tick; the last viewer leaving stops
 * both about ten seconds later (a reload or a quick trip to another tab finds
 * it still running). The 450-sample ring buffer (15 minutes at 2 s) lives on
 * the server, so switching tabs, going Back or reloading the app keeps the
 * history; time nobody watched stays a gap, it is never interpolated.
 *
 * One instance per server process, shared by every viewer. The sampler never
 * spawns anything per tick: the helper is one PowerShell for the whole
 * session, and the sensor fetches are the SensorReaders' own.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeReadline from "node:readline";

import type {
  PerformanceGroups,
  PerformanceSample,
  PerformanceSlow,
  PerformanceStatics,
  PerformanceStreamEvent,
} from "@t3tools/contracts";

import {
  busiestAdapter,
  clockGHz,
  gpuBusy,
  parseHelperHello,
  parseHelperTick,
  threadPct,
  type HelperChild,
  type HelperHello,
  type HelperSlow,
  type HelperTick,
} from "./counterSample.ts";
import {
  groupProcesses,
  topGroups,
  type BotOwner,
  type GroupedProcesses,
} from "./processGroups.ts";
import type { SensorsReading } from "./sensors.ts";

/** 450 samples at 2 s: the 15 minutes the charts keep. */
export const PERFORMANCE_HISTORY_SAMPLES = 450;
export const PERFORMANCE_TICK_MS = 2_000;
/** Process groups every second tick (4 s), as the spec allows when costly. */
export const PERFORMANCE_GROUP_EVERY = 2;
/** The helper and the timer stop this long after the last viewer leaves. */
export const PERFORMANCE_STOP_GRACE_MS = 10_000;
/** A helper that died is not restarted sooner than this. */
export const PERFORMANCE_HELPER_RESTART_MS = 30_000;

export interface HelperHandle {
  readonly pid: number | null;
  onLine: (listener: (line: string) => void) => void;
  onExit: (listener: () => void) => void;
  kill: () => void;
}

export interface DiskUsage {
  readonly dataGB: number | null;
  readonly backupsGB: number | null;
  readonly backupsCount: number | null;
  readonly releasesGB: number | null;
}

export interface PerformanceSamplerDeps {
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly serverPid?: number;
  /** Started once per run, stopped with the sampler; null when unsupported. */
  readonly startHelper?: () => HelperHandle | null;
  readonly readSensors?: () => SensorsReading;
  /** pid -> bot for the server's direct children, from their command lines. */
  readonly attribute?: (
    children: ReadonlyArray<HelperChild>,
  ) => Promise<ReadonlyMap<number, BotOwner>>;
  /** Disk sizes, cached for 10 minutes by the caller; may be slow. */
  readonly readDiskUsage?: () => Promise<DiskUsage | null>;
  readonly readStatics?: () => PerformanceStatics;
  readonly log?: (line: string) => void;
  readonly tickMs?: number;
  readonly stopGraceMs?: number;
  readonly helperRestartMs?: number;
  readonly historySize?: number;
}

export interface PerformanceSubscription {
  readonly hello: PerformanceStreamEvent;
  readonly onEvent: (listener: (event: PerformanceStreamEvent) => void) => void;
  readonly unsubscribe: () => void;
}

const NO_SENSORS_READING: SensorsReading = {
  lhm: "down",
  sensors: {
    cpuTempC: null,
    pCoreC: null,
    eCoreC: null,
    ssdC: null,
    ssdWarnC: null,
    ssdCritC: null,
    ramC: null,
    powerCpuW: null,
    powerGpuW: null,
    powerPlatformW: null,
    batteryRateW: null,
    batteryDesignWh: null,
    batteryFullWh: null,
  },
  fans: "down",
  fan: { status: "down", fan1Rpm: null, fan2Rpm: null },
};

/** The `os` view: the fallback when the counter helper is not (yet) there. */
interface OsCpuTracker {
  readonly pct: () => number | null;
}

export function makeOsCpuTracker(os: typeof NodeOS = NodeOS): OsCpuTracker {
  let last = os.cpus();
  return {
    pct: () => {
      const current = os.cpus();
      if (current.length !== last.length) {
        last = current;
        return null;
      }
      let busy = 0;
      let total = 0;
      for (let i = 0; i < current.length; i++) {
        const a = last[i]!.times;
        const b = current[i]!.times;
        const idle = b.idle - a.idle;
        const all =
          b.user + b.nice + b.sys + b.idle + b.irq - (a.user + a.nice + a.sys + a.idle + a.irq);
        busy += all - idle;
        total += all;
      }
      last = current;
      if (total <= 0) return null;
      return Math.round((busy / total) * 1000) / 10;
    },
  };
}

export class PerformanceSampler {
  private readonly deps: Required<
    Pick<
      PerformanceSamplerDeps,
      "platform" | "now" | "tickMs" | "stopGraceMs" | "helperRestartMs" | "historySize"
    >
  > &
    PerformanceSamplerDeps;
  private readonly osCpu = makeOsCpuTracker();
  private readonly history: PerformanceSample[] = [];
  private readonly listeners = new Set<(event: PerformanceStreamEvent) => void>();
  private timer: NodeJS.Timeout | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private helper: HelperHandle | null = null;
  private helperStartedAt = 0;
  private hello: HelperHello | null = null;
  private latestTick: HelperTick | null = null;
  /** The newest tick that carries the process snapshot (every second tick). */
  private latestGroupTick: HelperTick | null = null;
  /** The snapshot that has been grouped already; never grouped twice. */
  private lastGroupedTick: HelperTick | null = null;
  /** The newest slow block (battery, C: drive); sticky between its ticks. */
  private latestSlow: HelperSlow | null = null;
  private latestGroups: GroupedProcesses | null = null;
  private lastGroupsEvent: PerformanceGroups | null = null;
  private lastSample: PerformanceSample | null = null;
  private tickCount = 0;
  private viewers = 0;
  private diskUsage: DiskUsage | null = null;
  private diskUsageAt = 0;
  private diskInFlight = false;
  private attribution: ReadonlyMap<number, BotOwner> = new Map();
  private attributionInFlight = false;
  private restartBlockedUntil = 0;

  constructor(deps: PerformanceSamplerDeps = {}) {
    this.deps = {
      platform: deps.platform ?? process.platform,
      now: deps.now ?? (() => Date.now()),
      tickMs: deps.tickMs ?? PERFORMANCE_TICK_MS,
      stopGraceMs: deps.stopGraceMs ?? PERFORMANCE_STOP_GRACE_MS,
      helperRestartMs: deps.helperRestartMs ?? PERFORMANCE_HELPER_RESTART_MS,
      historySize: deps.historySize ?? PERFORMANCE_HISTORY_SAMPLES,
      ...deps,
    };
  }

  /** Snapshot for lifecycle proofs: what is running right now. */
  state(): {
    readonly running: boolean;
    readonly viewers: number;
    readonly helperPid: number | null;
    readonly hasTimer: boolean;
  } {
    return {
      running: this.timer !== null,
      viewers: this.viewers,
      helperPid: this.helper?.pid ?? null,
      hasTimer: this.timer !== null,
    };
  }

  subscribe(listener: (event: PerformanceStreamEvent) => void): PerformanceSubscription {
    const subscribeAt = this.deps.now();
    this.viewers += 1;
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.timer === null) this.start();
    this.listeners.add(listener);
    const slow = this.slowSnapshot(subscribeAt);
    const hello: PerformanceStreamEvent = {
      kind: "hello",
      statics: this.statics(),
      slow,
      history: [...this.history],
    };
    let unsubscribed = false;
    return {
      hello,
      onEvent: (next) => {
        this.listeners.add(next);
      },
      unsubscribe: () => {
        // Idempotent: a stream ending and a socket error both call it.
        if (unsubscribed) return;
        unsubscribed = true;
        this.listeners.delete(listener);
        this.viewers = Math.max(0, this.viewers - 1);
        if (this.viewers === 0 && this.stopTimer === null) {
          this.stopTimer = setTimeout(() => {
            this.stopTimer = null;
            this.stop();
          }, this.deps.stopGraceMs);
          this.stopTimer.unref?.();
        }
      },
    };
  }

  /** Start sampling now: helper first, then the tick. Idempotent. */
  private start(): void {
    if (this.timer !== null) return;
    this.ensureHelper();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.tickMs);
    this.timer.unref?.();
    this.deps.log?.("performance sampler started");
  }

  /** Stop everything this sampler owns. History stays for the next viewer. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.helper !== null) {
      this.helper.kill();
      this.helper = null;
      this.deps.log?.("performance sampler stopped, counter helper ended");
    }
  }

  private ensureHelper(): void {
    if (this.deps.platform !== "win32" || this.deps.startHelper === undefined) return;
    if (this.helper !== null) return;
    const now = this.deps.now();
    if (now < this.restartBlockedUntil) return;
    const helper = this.deps.startHelper();
    if (helper === null) {
      this.restartBlockedUntil = now + this.deps.helperRestartMs;
      return;
    }
    this.helper = helper;
    this.helperStartedAt = now;
    this.hello = null;
    this.latestTick = null;
    helper.onLine((line) => {
      const hello = parseHelperHello(line);
      if (hello !== null) {
        this.hello = hello;
        return;
      }
      const tick = parseHelperTick(line);
      if (tick !== null) {
        this.latestTick = tick;
        if (tick.parents !== null) this.latestGroupTick = tick;
        // The slow block rides every tenth tick; keep it until the next one.
        if (tick.slow !== null) this.latestSlow = tick.slow;
      }
    });
    helper.onExit(() => {
      if (this.helper !== helper) return;
      this.helper = null;
      this.latestTick = null;
      this.latestGroupTick = null;
      this.lastGroupedTick = null;
      this.restartBlockedUntil = this.deps.now() + this.deps.helperRestartMs;
      this.deps.log?.("performance counter helper exited");
    });
  }

  /** One 2 s tick: counters, sensors, sample, and every other tick the groups. */
  private async tick(): Promise<void> {
    const now = this.deps.now();
    this.tickCount += 1;
    // The helper is started lazily and restarted after a crash, both only
    // while sampling: while nobody watches, neither exists.
    if (this.helper === null) this.ensureHelper();

    const tick = this.latestTick;
    const reading = this.deps.readSensors?.() ?? NO_SENSORS_READING;
    const osCpu = this.osCpu.pct();

    const tickAgeMs = tick === null ? Number.POSITIVE_INFINITY : now - tick.t;
    const fresh = tickAgeMs <= this.deps.tickMs * 2.5 ? tick : null;
    const logical = this.hello?.logicalProcessors ?? NodeOS.cpus().length;

    // The newest tick that carries the process snapshot, grouped once per it:
    // the helper's group ticks and this sampler's cadence have no fixed phase,
    // so "whatever arrived last" would sometimes never carry parents.
    const groupTick =
      this.latestGroupTick !== null &&
      this.latestGroupTick !== this.lastGroupedTick &&
      now - this.latestGroupTick.t <= this.deps.tickMs * 3
        ? this.latestGroupTick
        : null;
    if (groupTick !== null && this.tickCount % PERFORMANCE_GROUP_EVERY === 0) {
      // Attribution is a database read; it runs at most once per group
      // refresh and never blocks a tick.
      if (!this.attributionInFlight && this.deps.attribute !== undefined) {
        this.attributionInFlight = true;
        void this.deps
          .attribute(groupTick.children)
          .then((map) => {
            this.attribution = map;
          })
          .catch(() => undefined)
          .finally(() => {
            this.attributionInFlight = false;
          });
      }
      this.lastGroupedTick = groupTick;
      this.latestGroups = groupProcesses({
        processes: groupTick.processes,
        parents: groupTick.parents ?? [],
        children: groupTick.children,
        attributed: this.attribution,
        serverPid: this.deps.serverPid ?? process.pid,
        logicalProcessors: logical,
      });
      const top = topGroups(this.latestGroups.groups, 15);
      const event: PerformanceStreamEvent = {
        kind: "groups",
        groups: { t: now, cpu: top.cpu, mem: top.mem, hbots: this.latestGroups.hbots },
      };
      this.lastGroupsEvent = event.groups;
      this.broadcast(event);
    }

    this.sampleDiskUsage(now);
    const slow = this.slowSnapshot(now);
    // Broadcast on change only: `t` moves every tick, everything else does not.
    const slowKey = JSON.stringify({ ...slow, t: 0 });
    if (this.lastSlowBroadcast !== slowKey) {
      this.lastSlowBroadcast = slowKey;
      this.broadcast({ kind: "slow", slow });
    }

    const memoryTotalGB = this.totalMemoryGB();
    const availableMB = fresh?.memAvailableMB ?? null;
    const hbots = this.lastGroupsEvent?.hbots ?? null;
    const gpu = fresh === null ? null : gpuBusy(fresh.gpu);
    const adapter = fresh === null ? null : busiestAdapter(fresh.netRx, fresh.netTx);
    const netDownMbps = adapter === null ? null : (adapter.downBps * 8) / 1e6;
    const netUpMbps = adapter === null ? null : (adapter.upBps * 8) / 1e6;

    const sample: PerformanceSample = {
      t: now,
      // % Processor Utility can read past 100 under turbo; the machine is
      // still just 100% busy.
      cpuPct:
        fresh?.cpuUtility === null || fresh?.cpuUtility === undefined
          ? osCpu
          : Math.min(100, Math.round(fresh.cpuUtility * 10) / 10),
      clockGHz:
        fresh === null ? null : clockGHz(fresh.cpuPerformance, this.hello?.maxClockMHz ?? null),
      threadPct: fresh === null ? null : threadPct(fresh.threads, logical),
      memUsedGB:
        memoryTotalGB === null || availableMB === null
          ? null
          : Math.round((memoryTotalGB - availableMB / 1024) * 10) / 10,
      memFreeGB: availableMB === null ? null : Math.round((availableMB / 1024) * 10) / 10,
      memTotalGB: memoryTotalGB,
      hbotsPct: hbots === null ? null : Math.min(100, hbots.total.cpuPct),
      hbotsGB: hbots === null ? null : hbots.total.memGB,
      gpuPct: gpu === null ? null : Math.round(gpu.pct * 10) / 10,
      gpuEngine: gpu === null ? null : gpu.engine,
      diskActivePct:
        fresh?.diskIdlePct === null || fresh?.diskIdlePct === undefined
          ? null
          : Math.round((100 - fresh.diskIdlePct) * 10) / 10,
      diskReadMBps:
        fresh?.diskReadBps === null || fresh?.diskReadBps === undefined
          ? null
          : Math.round((fresh.diskReadBps / 1e6) * 100) / 100,
      diskWriteMBps:
        fresh?.diskWriteBps === null || fresh?.diskWriteBps === undefined
          ? null
          : Math.round((fresh.diskWriteBps / 1e6) * 100) / 100,
      netDownMbps: netDownMbps === null ? null : Math.round(netDownMbps * 10) / 10,
      netUpMbps: netUpMbps === null ? null : Math.round(netUpMbps * 10) / 10,
      netAdapter: adapter === null ? null : adapter.name,
      cpuTempC: reading.lhm === "ok" ? reading.sensors.cpuTempC : null,
      pCoreC: reading.lhm === "ok" ? reading.sensors.pCoreC : null,
      eCoreC: reading.lhm === "ok" ? reading.sensors.eCoreC : null,
      ssdC: reading.lhm === "ok" ? reading.sensors.ssdC : null,
      ssdWarnC: reading.lhm === "ok" ? reading.sensors.ssdWarnC : null,
      ssdCritC: reading.lhm === "ok" ? reading.sensors.ssdCritC : null,
      ramC: reading.lhm === "ok" ? reading.sensors.ramC : null,
      powerCpuW: reading.lhm === "ok" ? reading.sensors.powerCpuW : null,
      powerGpuW: reading.lhm === "ok" ? reading.sensors.powerGpuW : null,
      powerPlatformW: reading.lhm === "ok" ? reading.sensors.powerPlatformW : null,
      batteryRateW: reading.lhm === "ok" ? reading.sensors.batteryRateW : null,
      fan1Rpm: reading.fans === "ok" ? reading.fan.fan1Rpm : null,
      fan2Rpm: reading.fans === "ok" ? reading.fan.fan2Rpm : null,
      fanStatus: reading.fan.status,
      lhm: reading.lhm,
      fans: reading.fans,
    };

    this.lastSample = sample;
    this.history.push(sample);
    if (this.history.length > this.deps.historySize) this.history.shift();
    this.broadcast({ kind: "sample", sample });
  }

  private broadcast(event: PerformanceStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A dead SSE writer must not stop the sampler; it unsubscribes itself.
      }
    }
  }

  private lastSlowBroadcast: string | null = null;

  private totalMemoryGB(): number | null {
    if (this.hello !== null && this.hello.memTotalMB > 0) {
      return Math.round((this.hello.memTotalMB / 1024) * 10) / 10;
    }
    const total = NodeOS.totalmem();
    return total > 0 ? Math.round((total / 1024 ** 3) * 10) / 10 : null;
  }

  private slowSnapshot(now: number): PerformanceSlow {
    const reading = this.deps.readSensors?.() ?? NO_SENSORS_READING;
    return {
      t: now,
      batteryPct: this.batteryPct,
      batteryState: this.batteryState,
      batteryMinutesLeft: this.batteryMinutes,
      batteryDesignWh: reading.lhm === "ok" ? reading.sensors.batteryDesignWh : null,
      batteryFullWh: reading.lhm === "ok" ? reading.sensors.batteryFullWh : null,
      diskTotalGB: this.diskTotalGB,
      diskFreeGB: this.diskFreeGB,
      dataGB: this.diskUsage?.dataGB ?? null,
      backupsGB: this.diskUsage?.backupsGB ?? null,
      backupsCount: this.diskUsage?.backupsCount ?? null,
      releasesGB: this.diskUsage?.releasesGB ?? null,
    };
  }

  /**
   * Battery and the C: drive: the helper carries them on its slow cadence
   * (every 20 s), read here from the newest tick.
   */
  private get batteryPct(): number | null {
    return this.latestSlow?.batteryPct ?? null;
  }
  private get batteryState(): PerformanceSlow["batteryState"] {
    return this.latestSlow?.batteryState ?? "unknown";
  }
  private get batteryMinutes(): number | null {
    return this.latestSlow?.batteryMinutesLeft ?? null;
  }
  private get diskTotalGB(): number | null {
    return this.latestSlow?.diskTotalGB ?? null;
  }
  private get diskFreeGB(): number | null {
    return this.latestSlow?.diskFreeGB ?? null;
  }

  private sampleDiskUsage(now: number): void {
    if (this.deps.readDiskUsage === undefined) return;
    const stale = now - this.diskUsageAt > 10 * 60_000;
    if (!stale || this.diskInFlight) return;
    this.diskInFlight = true;
    void this.deps
      .readDiskUsage()
      .then((usage) => {
        this.diskUsage = usage;
        this.diskUsageAt = this.deps.now();
      })
      .catch(() => undefined)
      .finally(() => {
        this.diskInFlight = false;
      });
  }

  private statics(): PerformanceStatics {
    const base = this.deps.readStatics?.() ?? {
      pcModel: null,
      pcCpu: null,
      pcCores: null,
      pcThreads: null,
      pcGpu: null,
      ramGB: null,
      pcBootAt: null,
      hbotsVersion: null,
      hbotsStartedAt: this.deps.now(),
    };
    return {
      ...base,
      pcCores: base.pcCores ?? this.hello?.physCores ?? null,
      pcThreads: base.pcThreads ?? this.hello?.logicalProcessors ?? NodeOS.cpus().length,
      pcModel: base.pcModel ?? this.hello?.model ?? null,
      pcCpu: base.pcCpu ?? this.hello?.cpuName ?? null,
      pcGpu: base.pcGpu ?? this.hello?.gpuName ?? null,
      pcBootAt: base.pcBootAt ?? this.hello?.pcBootAt ?? null,
    };
  }

  /** The newest sample, for tests and proofs. */
  lastSampleForTest(): PerformanceSample | null {
    return this.lastSample;
  }

  /** The ring buffer, for tests. */
  historyForTest(): ReadonlyArray<PerformanceSample> {
    return this.history;
  }
}
