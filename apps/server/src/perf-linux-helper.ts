// @effect-diagnostics nodeBuiltinImport:off - this is the Linux counter helper: plain /proc reads, no services.
// @effect-diagnostics globalDate:off - a standalone helper process; Effect's Clock does not apply.
// @effect-diagnostics globalTimers:off - it prints a line on its own interval, outside any Effect runtime.
/**
 * The Linux counter helper: the counterpart of `perf-helper.ps1`, printing the
 * same JSON lines (`hello`, then one tick every `--tick-ms`, with the slow
 * battery/disk block every tenth) so the sampler and the Performance tab need
 * no platform branch of their own.
 *
 * It runs as its own process, like the PowerShell helper, because walking
 * every `/proc/<pid>` every two seconds must never sit on the server's main
 * thread (Harout's no-lag rule). Started by `personal/performance/runtime.ts`
 * and stopped by captured PID when the last viewer leaves.
 *
 *   node perf-linux-helper.mjs --parent-pid 1234 --tick-ms 2000
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  commandLineOf,
  cpuPercent,
  diskRates,
  LINUX_CLOCK_TICKS,
  LINUX_PAGE_BYTES,
  netTables,
  parseDiskStats,
  parseMeminfo,
  parseNetDev,
  parsePidStat,
  parseProcStat,
  processCpuPercent,
  threadPercent,
  type LinuxCpuTimes,
  type LinuxDiskCounters,
  type LinuxNetCounters,
  type LinuxProcessStat,
} from "./personal/performance/linuxCounters.ts";
import { readLinuxBattery } from "./personal/performance/linuxSensors.ts";

const SYS = "/";
const PROC = "/proc";

const readText = (file: string): string | null => {
  try {
    return NodeFS.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const readNumber = (file: string): number | null => {
  const text = readText(file);
  if (text === null) return null;
  const value = Number.parseFloat(text.trim());
  return Number.isFinite(value) ? value : null;
};

const identify = (file: string): string | null => {
  const text = readText(file);
  if (text === null || text === "") return null;
  return text.trim();
};

interface Hello {
  readonly kind: "hello";
  readonly memTotalMB: number;
  readonly pcBootAt: number | null;
  readonly model: string | null;
  readonly cpuName: string | null;
  readonly physCores: number | null;
  readonly logicalProcessors: number | null;
  readonly maxClockMHz: number | null;
  readonly gpuName: string | null;
}

interface ChildRow {
  readonly pid: number;
  readonly name: string;
  readonly cpu100ns: number;
  readonly wsBytes: number;
  readonly cmd: string;
}

interface ProcessRow {
  readonly name: string;
  readonly cpuOneCore: number;
  readonly memBytes: number;
  readonly pid: number;
}

interface SlowRow {
  readonly batteryPct: number | null;
  readonly batteryState: string;
  readonly batteryMinutesLeft: number | null;
  readonly diskTotalGB: number | null;
  readonly diskFreeGB: number | null;
}

/** Intel and AMD vendor ids for the one-line GPU name; the model stays unknown. */
const gpuName = (): string | null => {
  const base = NodePath.join(SYS, "class", "drm");
  let entries: string[] = [];
  try {
    entries = NodeFS.readdirSync(base);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^card\d+$/.test(entry)) continue;
    const uevent = readText(NodePath.join(base, entry, "device", "uevent"));
    if (uevent === null) continue;
    const vendor = /PCI_ID=([0-9A-Fa-f]{4}):/.exec(uevent)?.[1]?.toLowerCase();
    if (vendor === "8086") return "Intel Graphics";
    if (vendor === "1002") return "AMD Radeon Graphics";
    if (vendor === "10de") return "NVIDIA Graphics";
    if (vendor === undefined) return "DRM device";
  }
  return null;
};

/** Physical cores: unique (package, core) pairs in cpuinfo; fallback to "cpu cores". */
const physicalCores = (cpuInfo: string): number | null => {
  const cores = new Set<string>();
  let packageId = "0";
  let fallback: number | null = null;
  for (const line of cpuInfo.split("\n")) {
    const pair = /^(physical id|core id)\s*:\s*(\d+)/.exec(line);
    if (pair !== null) {
      if (pair[1] === "physical id") packageId = pair[2]!;
      else cores.add(`${packageId}:${pair[2]!}`);
      continue;
    }
    const count = /^cpu cores\s*:\s*(\d+)/.exec(line);
    if (count !== null) fallback = Number.parseInt(count[1]!, 10);
  }
  if (cores.size > 0) return cores.size;
  return fallback;
};

const maxClockMHz = (): number | null => {
  const khz = readNumber(NodePath.join(SYS, "devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq"));
  if (khz !== null && khz > 0) return Math.round(khz / 1000);
  const cpuInfo = readText(NodePath.join(PROC, "cpuinfo")) ?? "";
  const mhz = /^cpu MHz\s*:\s*([\d.]+)/m.exec(cpuInfo)?.[1];
  if (mhz !== undefined) return Math.round(Number.parseFloat(mhz));
  return null;
};

/** The mean current clock, as a percentage of the rated clock (the Windows counter). */
const currentPerformancePct = (ratedMHz: number | null): number | null => {
  if (ratedMHz === null || ratedMHz <= 0) return null;
  const base = NodePath.join(SYS, "devices/system/cpu");
  let entries: string[] = [];
  try {
    entries = NodeFS.readdirSync(base).filter((entry) => /^cpu\d+$/.test(entry));
  } catch {
    entries = [];
  }
  const values: number[] = [];
  for (const entry of entries) {
    const khz = readNumber(NodePath.join(base, entry, "cpufreq", "scaling_cur_freq"));
    if (khz !== null && khz > 0) values.push(khz / 1000);
  }
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.round(Math.min(1000, (mean / ratedMHz) * 100) * 10) / 10;
};

const diskSpace = (): { readonly totalGB: number | null; readonly freeGB: number | null } => {
  try {
    const stats = NodeFS.statfsSync(SYS);
    return {
      totalGB: Math.round(((stats.blocks * stats.bsize) / 1024 ** 3) * 10) / 10,
      freeGB: Math.round(((stats.bavail * stats.bsize) / 1024 ** 3) * 10) / 10,
    };
  } catch {
    return { totalGB: null, freeGB: null };
  }
};

const hello = (): Hello => {
  const meminfo = parseMeminfo(readText(NodePath.join(PROC, "meminfo")) ?? "");
  const procStat = parseProcStat(readText(NodePath.join(PROC, "stat")) ?? "");
  const cpuInfo = readText(NodePath.join(PROC, "cpuinfo")) ?? "";
  const cpuName = /^model name\s*:\s*(.+)$/m.exec(cpuInfo)?.[1]?.trim() ?? null;
  return {
    kind: "hello",
    memTotalMB: meminfo.totalMB,
    pcBootAt: procStat.bootAtMs,
    model: identify(NodePath.join(SYS, "class/dmi/id/product_name")),
    cpuName,
    physCores: physicalCores(cpuInfo),
    logicalProcessors: procStat.threads.length > 0 ? procStat.threads.length : null,
    maxClockMHz: maxClockMHz(),
    gpuName: gpuName(),
  };
};

/** Every process, one `/proc/<pid>/stat` each; command lines only for our children. */
const readProcesses = (
  parentPid: number,
): {
  readonly processes: ReadonlyArray<LinuxProcessStat>;
  readonly children: ReadonlyArray<{ readonly stat: LinuxProcessStat; readonly cmd: string }>;
} => {
  const processes: LinuxProcessStat[] = [];
  const children: Array<{ stat: LinuxProcessStat; cmd: string }> = [];
  let entries: string[] = [];
  try {
    entries = NodeFS.readdirSync(PROC);
  } catch {
    return { processes, children };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const text = readText(NodePath.join(PROC, entry, "stat"));
    if (text === null) continue;
    const stat = parsePidStat(text);
    if (stat === null) continue;
    processes.push(stat);
    if (stat.parentPid === parentPid) {
      const cmd = readText(NodePath.join(PROC, entry, "cmdline"));
      children.push({ stat, cmd: cmd === null ? "" : commandLineOf(cmd) });
    }
  }
  return { processes, children };
};

const parseArgs = (argv: ReadonlyArray<string>): { parentPid: number; tickMs: number } => {
  let parentPid = 0;
  let tickMs = 2000;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--parent-pid") parentPid = Number.parseInt(argv[index + 1] ?? "", 10);
    else if (value === "--tick-ms") tickMs = Number.parseInt(argv[index + 1] ?? "", 10);
  }
  return {
    parentPid: Number.isFinite(parentPid) ? parentPid : 0,
    tickMs: Number.isFinite(tickMs) && tickMs >= 500 ? tickMs : 2000,
  };
};

const main = (): void => {
  const { parentPid, tickMs } = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(hello())}\n`);

  let previousCpu: LinuxCpuTimes | null = null;
  let previousThreads: ReadonlyArray<LinuxCpuTimes> = [];
  let previousDisk: ReadonlyMap<string, LinuxDiskCounters> = new Map();
  let previousNet: ReadonlyArray<LinuxNetCounters> = [];
  let previousProcessTicks = new Map<number, number>();
  let previousAt = Date.now();
  let tick = 0;

  const emit = (): void => {
    const now = Date.now();
    const elapsedMs = now - previousAt;
    const procStat = parseProcStat(readText(NodePath.join(PROC, "stat")) ?? "");
    const memory = parseMeminfo(readText(NodePath.join(PROC, "meminfo")) ?? "");
    const disk = parseDiskStats(readText(NodePath.join(PROC, "diskstats")) ?? "");
    const net = parseNetDev(readText(NodePath.join(PROC, "net/dev")) ?? "");
    const snapshot = readProcesses(parentPid);

    const rates = diskRates(previousDisk, disk, elapsedMs);
    const tables = netTables(previousNet, net, elapsedMs);
    const processRows: ProcessRow[] = [];
    const nextProcessTicks = new Map<number, number>();
    for (const stat of snapshot.processes) {
      nextProcessTicks.set(stat.pid, stat.cpuTicks);
      processRows.push({
        name: stat.name,
        cpuOneCore: processCpuPercent(
          previousProcessTicks.get(stat.pid),
          stat.cpuTicks,
          elapsedMs,
        ),
        memBytes: stat.rssPages * LINUX_PAGE_BYTES,
        pid: stat.pid,
      });
    }
    const childRows: ChildRow[] = snapshot.children.map((child) => ({
      pid: child.stat.pid,
      name: child.stat.name,
      // The helper's unit is 100 ns, like the Windows kernel times.
      cpu100ns: child.stat.cpuTicks * (10_000_000 / LINUX_CLOCK_TICKS),
      wsBytes: child.stat.rssPages * LINUX_PAGE_BYTES,
      cmd: child.cmd,
    }));

    tick += 1;
    let slow: SlowRow | null = null;
    if (tick % 10 === 0) {
      const battery = readLinuxBattery(SYS);
      const space = diskSpace();
      slow = {
        batteryPct: battery.pct,
        batteryState: battery.state,
        batteryMinutesLeft: battery.minutesLeft,
        diskTotalGB: space.totalGB,
        diskFreeGB: space.freeGB,
      };
    }

    const line = {
      t: now,
      ms: Math.round(elapsedMs),
      c: {
        cpuUtility: previousCpu === null ? null : cpuPercent(previousCpu, procStat.total),
        cpuPerformance: currentPerformancePct(maxClockMHz()),
        memAvailableMB: memory.availableMB,
        diskIdlePct: rates === null ? null : Math.round((100 - rates.activePct) * 10) / 10,
        diskReadBps: rates === null ? null : Math.round(rates.readBps),
        diskWriteBps: rates === null ? null : Math.round(rates.writeBps),
        threads: threadPercent(previousThreads, procStat.threads),
        gpu: [],
        netRx: tables.rx,
        netTx: tables.tx,
        proc: processRows.map((row) => [row.name, row.cpuOneCore, row.memBytes, row.pid]),
      },
      k: childRows,
      pp: snapshot.processes.map((stat) => [stat.pid, stat.parentPid, 1]),
      s: slow,
    };
    process.stdout.write(`${JSON.stringify(line)}\n`);

    previousCpu = procStat.total;
    previousThreads = procStat.threads;
    previousDisk = disk;
    previousNet = net;
    previousProcessTicks = nextProcessTicks;
    previousAt = now;
  };

  // Keep the event loop alive: an unref'd interval lets Node exit as soon as
  // the hello line is written, which left the sampler with no ticks at all.
  const timer = setInterval(emit, tickMs);
  // The sampler kills this process by PID; either signal ends the loop.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      clearInterval(timer);
      process.exit(0);
    });
  }
  // The parent closing the pipe (a server restart) ends the helper too.
  process.stdout.on("error", () => process.exit(0));
};

main();
