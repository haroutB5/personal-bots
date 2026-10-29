/**
 * The `/proc` side of the Linux counter helper: pure parsers, so the tests feed
 * recorded files instead of this machine's live counters.
 *
 * The helper (`src/perf-linux-helper.ts`) keeps the previous reading and turns
 * the deltas into the same JSON lines the Windows PowerShell helper prints, so
 * `counterSample.ts`, the sampler and the Performance tab stay one code path.
 * Nothing here is Windows-specific and nothing here spawns anything.
 */

export interface LinuxCpuTimes {
  /** "cpu" for the total, "cpu0".."cpuN" for one thread. */
  readonly name: string;
  /** Everything except idle and iowait, in USER_HZ ticks. */
  readonly busy: number;
  /** Every field the kernel reports, in USER_HZ ticks. */
  readonly total: number;
}

export interface LinuxProcStat {
  readonly total: LinuxCpuTimes;
  readonly threads: ReadonlyArray<LinuxCpuTimes>;
  /** Wall clock of the boot, from the kernel's own `btime` line. */
  readonly bootAtMs: number | null;
}

/**
 * `/proc/stat`. A line is accounted from the first field after the name; guest
 * and guest_nice are left out because the kernel already counts them in user
 * and nice (adding both would count them twice).
 */
export function parseProcStat(text: string): LinuxProcStat {
  let total: LinuxCpuTimes | null = null;
  const threads: LinuxCpuTimes[] = [];
  let bootAtMs: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("btime ")) {
      const seconds = Number.parseInt(line.slice("btime ".length).trim(), 10);
      if (Number.isFinite(seconds) && seconds > 0) bootAtMs = seconds * 1000;
      continue;
    }
    const match = /^(cpu\d*)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const fields = match[2]!.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
    if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) continue;
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
      fields;
    const totalTicks = user + nice + system + idle + iowait + irq + softirq + steal;
    const entry: LinuxCpuTimes = {
      name: match[1]!,
      busy: totalTicks - idle - iowait,
      total: totalTicks,
    };
    if (entry.name === "cpu") {
      total = entry;
    } else {
      threads.push(entry);
    }
  }
  if (total === null) {
    total = { name: "cpu", busy: 0, total: 0 };
  }
  return { total, threads, bootAtMs };
}

/** Busy percent of the whole machine between two readings, one decimal. */
export function cpuPercent(previous: LinuxCpuTimes, next: LinuxCpuTimes): number | null {
  const total = next.total - previous.total;
  if (total <= 0) return null;
  const busy = next.busy - previous.busy;
  return Math.round((Math.max(0, Math.min(busy, total)) / total) * 1000) / 10;
}

/** Busy percent of ONE core per thread, keyed `0,<index>` like the Windows lines. */
export function threadPercent(
  previous: ReadonlyArray<LinuxCpuTimes>,
  next: ReadonlyArray<LinuxCpuTimes>,
): ReadonlyArray<readonly [string, number | null]> {
  const before = new Map(previous.map((entry) => [entry.name, entry]));
  const out: Array<readonly [string, number | null]> = [];
  for (const entry of next) {
    const match = /^cpu(\d+)$/.exec(entry.name);
    if (match === null) continue;
    const old = before.get(entry.name);
    const total = old === undefined ? 0 : entry.total - old.total;
    const pct =
      old === undefined || total <= 0
        ? null
        : Math.max(0, Math.min(100, Math.round(((entry.busy - old.busy) / total) * 1000) / 10));
    out.push([`0,${match[1]}`, pct]);
  }
  return out;
}

export interface LinuxMemory {
  readonly totalMB: number;
  readonly availableMB: number | null;
}

/**
 * `/proc/meminfo`. `MemAvailable` is the kernel's own estimate (caches
 * included, which is what a user means by "free"); an old kernel without it
 * gets MemFree, so the number is smaller but never a lie.
 */
export function parseMeminfo(text: string): LinuxMemory {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match !== null) values.set(match[1]!, Number.parseInt(match[2]!, 10));
  }
  const toMB = (key: string): number | null => {
    const kb = values.get(key);
    return kb === undefined ? null : Math.round((kb / 1024) * 10) / 10;
  };
  return {
    totalMB: toMB("MemTotal") ?? 0,
    availableMB: toMB("MemAvailable") ?? toMB("MemFree"),
  };
}

export interface LinuxDiskCounters {
  readonly readSectors: number;
  readonly writtenSectors: number;
  /** Milliseconds the device had I/O in flight. */
  readonly ioTimeMs: number;
}

/**
 * `/proc/diskstats`, physical devices only. `loop*`, `ram*` and the partition
 * entries are skipped: partitions report the same I/O as their disk, so adding
 * both would double the throughput.
 */
export function parseDiskStats(text: string): Map<string, LinuxDiskCounters> {
  const out = new Map<string, LinuxDiskCounters>();
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) continue;
    const name = fields[2]!;
    if (/^(loop|ram|dm-|sr)/.test(name)) continue;
    if (/^nvme\d+n\d+p\d+$/.test(name) || /^mmcblk\d+p\d+$/.test(name)) continue;
    if (/^(sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z])[0-9]+$/.test(name)) continue;
    const readSectors = Number.parseInt(fields[5]!, 10);
    const writtenSectors = Number.parseInt(fields[9]!, 10);
    const ioTimeMs = Number.parseInt(fields[12]!, 10);
    if (![readSectors, writtenSectors, ioTimeMs].every((value) => Number.isFinite(value))) {
      continue;
    }
    out.set(name, { readSectors, writtenSectors, ioTimeMs });
  }
  return out;
}

export interface LinuxDiskRates {
  readonly readBps: number;
  readonly writeBps: number;
  /** Percent of the elapsed time the busiest disk had I/O in flight. */
  readonly activePct: number;
}

/** Sectors are always 512 bytes in `/proc/diskstats`, whatever the device. */
export function diskRates(
  previous: ReadonlyMap<string, LinuxDiskCounters>,
  next: ReadonlyMap<string, LinuxDiskCounters>,
  elapsedMs: number,
): LinuxDiskRates | null {
  if (elapsedMs <= 0 || previous.size === 0 || next.size === 0) return null;
  let readSectors = 0;
  let writtenSectors = 0;
  let worstBusyPct = 0;
  let matched = false;
  for (const [name, entry] of next) {
    const old = previous.get(name);
    if (old === undefined) continue;
    const readDelta = Math.max(0, entry.readSectors - old.readSectors);
    const writeDelta = Math.max(0, entry.writtenSectors - old.writtenSectors);
    const ioDelta = Math.max(0, entry.ioTimeMs - old.ioTimeMs);
    readSectors += readDelta;
    writtenSectors += writeDelta;
    worstBusyPct = Math.max(worstBusyPct, Math.min(100, (ioDelta / elapsedMs) * 100));
    matched = true;
  }
  if (!matched) return null;
  return {
    readBps: (readSectors * 512 * 1000) / elapsedMs,
    writeBps: (writtenSectors * 512 * 1000) / elapsedMs,
    activePct: Math.round(worstBusyPct * 10) / 10,
  };
}

export interface LinuxNetCounters {
  readonly name: string;
  readonly rxBytes: number;
  readonly txBytes: number;
}

/** `/proc/net/dev`, loopback left out: the app's own traffic is never "network". */
export function parseNetDev(text: string): ReadonlyArray<LinuxNetCounters> {
  const out: LinuxNetCounters[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([^:\s]+):\s*(.+)$/.exec(line);
    if (match === null) continue;
    const name = match[1]!;
    if (name === "lo" || name === "Inter-|" || name === "face") continue;
    const fields = match[2]!.trim().split(/\s+/);
    if (fields.length < 9) continue;
    const rxBytes = Number.parseInt(fields[0]!, 10);
    const txBytes = Number.parseInt(fields[8]!, 10);
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    out.push({ name, rxBytes, txBytes });
  }
  return out;
}

export function netRates(
  previous: ReadonlyArray<LinuxNetCounters>,
  next: ReadonlyArray<LinuxNetCounters>,
  elapsedMs: number,
): ReadonlyArray<readonly [string, number | null]> {
  if (elapsedMs <= 0) return [];
  const before = new Map(previous.map((entry) => [entry.name, entry]));
  const sameLength = previous.length === next.length;
  const out: Array<readonly [string, number | null]> = [];
  for (const entry of next) {
    const old = before.get(entry.name);
    const rx =
      old === undefined || !sameLength
        ? null
        : Math.max(0, ((entry.rxBytes - old.rxBytes) * 1000) / elapsedMs);
    const tx =
      old === undefined || !sameLength
        ? null
        : Math.max(0, ((entry.txBytes - old.txBytes) * 1000) / elapsedMs);
    out.push([entry.name, rx]);
    if (tx !== null) out.push([`${entry.name} (up)`, tx]);
  }
  return out;
}

/** Separate receive and transmit tables, the shape the helper lines carry. */
export function netTables(
  previous: ReadonlyArray<LinuxNetCounters>,
  next: ReadonlyArray<LinuxNetCounters>,
  elapsedMs: number,
): {
  readonly rx: ReadonlyArray<readonly [string, number | null]>;
  readonly tx: ReadonlyArray<readonly [string, number | null]>;
} {
  const before = new Map(previous.map((entry) => [entry.name, entry]));
  const rx: Array<readonly [string, number | null]> = [];
  const tx: Array<readonly [string, number | null]> = [];
  for (const entry of next) {
    const old = before.get(entry.name);
    if (old === undefined) continue;
    rx.push([entry.name, Math.max(0, ((entry.rxBytes - old.rxBytes) * 1000) / elapsedMs)]);
    tx.push([entry.name, Math.max(0, ((entry.txBytes - old.txBytes) * 1000) / elapsedMs)]);
  }
  return { rx, tx };
}

export interface LinuxProcessStat {
  readonly pid: number;
  readonly name: string;
  readonly parentPid: number;
  /** utime + stime, USER_HZ ticks. */
  readonly cpuTicks: number;
  /** Resident set, pages. */
  readonly rssPages: number;
}

/**
 * `/proc/<pid>/stat`. The command name sits in parentheses and may itself hold
 * spaces and parentheses, so the fields are counted from the LAST `)`, which is
 * the only robust way to read this file.
 */
export function parsePidStat(text: string): LinuxProcessStat | null {
  const close = text.lastIndexOf(")");
  const open = text.indexOf("(");
  if (open < 1 || close < open) return null;
  const pid = Number.parseInt(text.slice(0, open).trim(), 10);
  const name = text.slice(open + 1, close);
  const rest = text.slice(close + 1).trim().split(/\s+/);
  // rest[0] is field 3 (state), so field N is rest[N - 3].
  const field = (index: number): number => Number.parseInt(rest[index - 3] ?? "", 10);
  const parentPid = field(4);
  const cpuTicks = field(14) + field(15);
  const rssPages = field(24);
  if (!Number.isFinite(pid) || !Number.isFinite(parentPid) || !Number.isFinite(cpuTicks)) {
    return null;
  }
  return {
    pid,
    name,
    parentPid,
    cpuTicks,
    rssPages: Number.isFinite(rssPages) ? rssPages : 0,
  };
}

/** USER_HZ on every mainstream Linux build; `/proc` times are in these ticks. */
export const LINUX_CLOCK_TICKS = 100;
export const LINUX_PAGE_BYTES = 4096;

/** Percent of one core a process used between two snapshots. */
export function processCpuPercent(
  previousTicks: number | undefined,
  nextTicks: number,
  elapsedMs: number,
): number {
  if (previousTicks === undefined || elapsedMs <= 0) return 0;
  const ticks = Math.max(0, nextTicks - previousTicks);
  const seconds = elapsedMs / 1000;
  return Math.round(((ticks / LINUX_CLOCK_TICKS / seconds) * 100) * 10) / 10;
}

/** The `/proc/<pid>/cmdline` bytes as one line, the Windows `CommandLine`. */
export function commandLineOf(raw: string): string {
  return raw
    .split("\u0000")
    .filter((part) => part.length > 0)
    .join(" ")
    .trim();
}
