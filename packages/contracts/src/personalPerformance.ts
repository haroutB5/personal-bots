import * as Schema from "effect/Schema";

/*
 * Computer > Performance (1.67.2, Designer's SPEC-performance.md): the live
 * shape of the machine, for the Performance tab. One sample every 2 seconds
 * while at least one viewer is subscribed; groups every 4; slow facts every
 * few seconds to minutes. Units are fixed here (percent of the whole machine,
 * GB, MB/s, Mb/s, degrees Celsius, watts, rpm) and `null` always means "not
 * readable right now" - never 0. The client formats.
 */

/** Whether a reader answered this tick. */
export const PerformanceReaderState = Schema.Literals(["ok", "down"]);
export type PerformanceReaderState = typeof PerformanceReaderState.Type;

export const PerformanceFanStatus = Schema.Literals(["ok", "partial", "unavailable", "down"]);
export type PerformanceFanStatus = typeof PerformanceFanStatus.Type;

export const PerformanceSample = Schema.Struct({
  /** Server clock, epoch ms: the x axis. */
  t: Schema.Number,
  /** `\Processor Information(_Total)\% Processor Utility`, the number Task Manager shows. */
  cpuPct: Schema.NullOr(Schema.Number),
  clockGHz: Schema.NullOr(Schema.Number),
  /** Per logical processor, P-threads first (0-11), E after (12-19). */
  threadPct: Schema.NullOr(Schema.Array(Schema.Number)),
  memUsedGB: Schema.NullOr(Schema.Number),
  memFreeGB: Schema.NullOr(Schema.Number),
  memTotalGB: Schema.NullOr(Schema.Number),
  /** The hbots process tree's share, held between group refreshes. */
  hbotsPct: Schema.NullOr(Schema.Number),
  hbotsGB: Schema.NullOr(Schema.Number),
  gpuPct: Schema.NullOr(Schema.Number),
  gpuEngine: Schema.NullOr(Schema.String),
  diskActivePct: Schema.NullOr(Schema.Number),
  diskReadMBps: Schema.NullOr(Schema.Number),
  diskWriteMBps: Schema.NullOr(Schema.Number),
  netDownMbps: Schema.NullOr(Schema.Number),
  netUpMbps: Schema.NullOr(Schema.Number),
  netAdapter: Schema.NullOr(Schema.String),
  cpuTempC: Schema.NullOr(Schema.Number),
  pCoreC: Schema.NullOr(Schema.Array(Schema.Number)),
  eCoreC: Schema.NullOr(Schema.Array(Schema.Number)),
  ssdC: Schema.NullOr(Schema.Number),
  /** The drive's own limits, read from the sensor once. */
  ssdWarnC: Schema.NullOr(Schema.Number),
  ssdCritC: Schema.NullOr(Schema.Number),
  ramC: Schema.NullOr(Schema.Number),
  powerCpuW: Schema.NullOr(Schema.Number),
  powerGpuW: Schema.NullOr(Schema.Number),
  powerPlatformW: Schema.NullOr(Schema.Number),
  batteryRateW: Schema.NullOr(Schema.Number),
  fan1Rpm: Schema.NullOr(Schema.Number),
  fan2Rpm: Schema.NullOr(Schema.Number),
  fanStatus: PerformanceFanStatus,
  lhm: PerformanceReaderState,
  fans: PerformanceReaderState,
});
export type PerformanceSample = typeof PerformanceSample.Type;

export const PerformanceGroupKind = Schema.Literals(["bot", "hbots", "app", "system"]);
export type PerformanceGroupKind = typeof PerformanceGroupKind.Type;

export const PerformanceGroup = Schema.Struct({
  name: Schema.String,
  kind: PerformanceGroupKind,
  botId: Schema.NullOr(Schema.String),
  processCount: Schema.Number,
  /** Percent of the whole machine, like every cpu figure here. */
  cpuPct: Schema.Number,
  memGB: Schema.Number,
});
export type PerformanceGroup = typeof PerformanceGroup.Type;

/** The four rows of the hbots table: server, bots, browser, total. */
export const PerformanceHbotsRows = Schema.Struct({
  server: PerformanceGroup,
  bots: PerformanceGroup,
  browser: PerformanceGroup,
  total: PerformanceGroup,
});
export type PerformanceHbotsRows = typeof PerformanceHbotsRows.Type;

export const PerformanceGroups = Schema.Struct({
  t: Schema.Number,
  /** Top 15 by CPU, biggest first. */
  cpu: Schema.Array(PerformanceGroup),
  /** Top 15 by memory, biggest first. */
  mem: Schema.Array(PerformanceGroup),
  hbots: PerformanceHbotsRows,
});
export type PerformanceGroups = typeof PerformanceGroups.Type;

export const PerformanceBatteryState = Schema.Literals([
  "charging",
  "discharging",
  "full",
  "plugged",
  "unknown",
]);
export type PerformanceBatteryState = typeof PerformanceBatteryState.Type;

export const PerformanceSlow = Schema.Struct({
  t: Schema.Number,
  batteryPct: Schema.NullOr(Schema.Number),
  batteryState: PerformanceBatteryState,
  batteryMinutesLeft: Schema.NullOr(Schema.Number),
  batteryDesignWh: Schema.NullOr(Schema.Number),
  batteryFullWh: Schema.NullOr(Schema.Number),
  diskTotalGB: Schema.NullOr(Schema.Number),
  diskFreeGB: Schema.NullOr(Schema.Number),
  dataGB: Schema.NullOr(Schema.Number),
  backupsGB: Schema.NullOr(Schema.Number),
  backupsCount: Schema.NullOr(Schema.Number),
  releasesGB: Schema.NullOr(Schema.Number),
});
export type PerformanceSlow = typeof PerformanceSlow.Type;

export const PerformanceStatics = Schema.Struct({
  pcModel: Schema.NullOr(Schema.String),
  pcCpu: Schema.NullOr(Schema.String),
  pcCores: Schema.NullOr(Schema.Number),
  pcThreads: Schema.NullOr(Schema.Number),
  pcGpu: Schema.NullOr(Schema.String),
  ramGB: Schema.NullOr(Schema.Number),
  pcBootAt: Schema.NullOr(Schema.Number),
  hbotsVersion: Schema.NullOr(Schema.String),
  hbotsStartedAt: Schema.Number,
});
export type PerformanceStatics = typeof PerformanceStatics.Type;

/** One SSE frame. `hello` carries the history so a reload keeps its chart. */
export const PerformanceStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("hello"),
    statics: PerformanceStatics,
    slow: PerformanceSlow,
    history: Schema.Array(PerformanceSample),
  }),
  Schema.Struct({ kind: Schema.Literal("sample"), sample: PerformanceSample }),
  Schema.Struct({ kind: Schema.Literal("groups"), groups: PerformanceGroups }),
  Schema.Struct({ kind: Schema.Literal("slow"), slow: PerformanceSlow }),
  /**
   * The PC's identity, once the helper has answered (a viewer that started
   * sampling before the helper's greeting gets a statics frame when it
   * arrives; without it the footer's model line waited for a reload).
   */
  Schema.Struct({ kind: Schema.Literal("statics"), statics: PerformanceStatics }),
]);
export type PerformanceStreamEvent = typeof PerformanceStreamEvent.Type;
