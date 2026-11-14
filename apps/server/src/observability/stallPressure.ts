/**
 * What the OS did to the main thread during a stall, as deltas between a reading taken
 * once the heartbeat looked late and one taken after the stall ended. A file that could
 * not be read or parsed gives null fields, never a throw: the watchdog must keep running
 * on any host.
 */

/** Raw text of the files read at one moment. Null where the read failed. */
export interface PressureFiles {
  readonly at: number;
  readonly taskStat: string | null;
  readonly taskSchedstat: string | null;
  readonly memoryStat: string | null;
  readonly memoryPressure: string | null;
  readonly ioPressure: string | null;
  readonly cpuPressure: string | null;
}

export type PauseCause = "running" | "cpu" | "swap-in" | "disk" | "reclaim" | "kernel" | "blocked";

const COUNTERS = [
  "mainMajflt",
  "mainMinflt",
  "mainUserMs",
  "mainSystemMs",
  "mainRunqWaitMs",
  "pswpin",
  "pswpout",
  "pgmajfault",
  "workingsetRefaultAnon",
  "workingsetRefaultFile",
  "memorySomeMs",
  "ioSomeMs",
  "cpuSomeMs",
] as const;

type Counter = (typeof COUNTERS)[number];
export type PressureCounts = { readonly [K in Counter]: number | null };
/** The same counters as read, in the files' own units: ticks, ns, µs. */
type RawCounts = PressureCounts;

export type StallPressure = PressureCounts & {
  /** Span the deltas cover, from the first reading to the last. */
  readonly windowMs: number | null;
  /** How much of that span the main thread was stalled. */
  readonly coveredMs: number | null;
  readonly cause: PauseCause | null;
};

/** When the main thread ran again, and how long it had been stalled. */
export interface StallTiming {
  readonly endedAt: number;
  readonly durationMs: number;
}

/** /proc reports CPU time in USER_HZ ticks, which Linux fixes at 100 per second. */
const MS_PER_TICK = 10;

const SCALE: { readonly [K in Counter]: number } = {
  mainMajflt: 1,
  mainMinflt: 1,
  mainUserMs: MS_PER_TICK,
  mainSystemMs: MS_PER_TICK,
  mainRunqWaitMs: 1e-6,
  pswpin: 1,
  pswpout: 1,
  pgmajfault: 1,
  workingsetRefaultAnon: 1,
  workingsetRefaultFile: 1,
  memorySomeMs: 1e-3,
  ioSomeMs: 1e-3,
  cpuSomeMs: 1e-3,
};

/** Main-thread major faults in one stall that count as "large". A guess until real stalls tune it. */
const LARGE_MAJFLT = 50;

const toCount = (text: string | undefined): number | null => {
  if (text === undefined || !/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

/** Fields 10, 12, 14 and 15 of /proc/<pid>/task/<tid>/stat. The name field may hold spaces and parens. */
const parseTaskStat = (text: string | null) => {
  const close = text?.lastIndexOf(")") ?? -1;
  const fields =
    text === null || close < 0
      ? []
      : text
          .slice(close + 1)
          .trim()
          .split(/\s+/);
  const field = (n: number) => toCount(fields[n - 3]);
  return {
    mainMinflt: field(10),
    mainMajflt: field(12),
    mainUserMs: field(14),
    mainSystemMs: field(15),
  };
};

const parseRunqWaitNs = (text: string | null) => toCount(text?.trim().split(/\s+/)[1]);

const parseMemoryStat = (text: string | null) => {
  const values = new Map<string, string>();
  for (const line of text?.split("\n") ?? []) {
    const [key, value] = line.split(" ");
    if (key !== undefined && value !== undefined) values.set(key, value);
  }
  const value = (key: string) => toCount(values.get(key));
  return {
    pswpin: value("pswpin"),
    pswpout: value("pswpout"),
    pgmajfault: value("pgmajfault"),
    workingsetRefaultAnon: value("workingset_refault_anon"),
    workingsetRefaultFile: value("workingset_refault_file"),
  };
};

const parseSomeTotalUs = (text: string | null) =>
  toCount(/^some .*\btotal=(\d+)\s*$/m.exec(text ?? "")?.[1]);

const parsePressureFiles = (files: PressureFiles): RawCounts => ({
  ...parseTaskStat(files.taskStat),
  mainRunqWaitMs: parseRunqWaitNs(files.taskSchedstat),
  ...parseMemoryStat(files.memoryStat),
  memorySomeMs: parseSomeTotalUs(files.memoryPressure),
  ioSomeMs: parseSomeTotalUs(files.ioPressure),
  cpuSomeMs: parseSomeTotalUs(files.cpuPressure),
});

/**
 * The FINDINGS 8A rule, held to evidence about the main thread itself. The task stat and
 * schedstat are the main thread's own; memory.stat and the pressure files cover the
 * whole unit, so they only refine a verdict the main thread's numbers already point to.
 * Anything weaker gives null: a wrong label is worse than none.
 */
export const classifyPause = (delta: PressureCounts, windowMs: number): PauseCause | null => {
  if (windowMs <= 0) return null;
  const { mainUserMs, mainSystemMs, mainRunqWaitMs, mainMajflt } = delta;
  if (
    mainUserMs === null ||
    mainSystemMs === null ||
    mainRunqWaitMs === null ||
    mainMajflt === null
  ) {
    return null;
  }
  const half = windowMs / 2;
  if (mainUserMs >= half) return "running";
  if (mainRunqWaitMs >= half) return "cpu";
  if (mainMajflt >= LARGE_MAJFLT) return faultSource(delta, mainMajflt);
  if (mainSystemMs >= half) {
    if (delta.memorySomeMs === null) return null;
    return delta.memorySomeMs >= mainSystemMs / 2 ? "reclaim" : "kernel";
  }
  const offCpuMs = windowMs - mainUserMs - mainSystemMs - mainRunqWaitMs;
  return offCpuMs > half ? "blocked" : null;
};

/**
 * Swap or file, for main-thread major faults. memory.stat may lag until the kernel
 * flushes it, so it must show at least the main thread's faults to be trusted. Its swap
 * count can be pinned to the main thread only when that thread made nearly all of the
 * unit's major faults.
 */
const faultSource = (delta: PressureCounts, mainMajflt: number): PauseCause | null => {
  const { pswpin, pgmajfault } = delta;
  if (pswpin === null || pgmajfault === null || pgmajfault < mainMajflt) return null;
  if (pswpin === 0) return "disk";
  const otherMajflt = pgmajfault - mainMajflt;
  return pswpin >= mainMajflt && otherMajflt * 10 <= mainMajflt ? "swap-in" : null;
};

/**
 * The verdict needs the window to be mostly stall, and to see most of the stall: idle
 * time after a short stall would otherwise read as a wait.
 */
export const measureStallPressure = (
  start: PressureFiles,
  end: PressureFiles,
  stall: StallTiming,
): StallPressure => {
  const before = parsePressureFiles(start);
  const after = parsePressureFiles(end);
  const delta = Object.fromEntries(
    COUNTERS.map((key) => {
      const a = before[key];
      const b = after[key];
      return [key, a === null || b === null || b < a ? null : Math.round((b - a) * SCALE[key])];
    }),
  ) as PressureCounts;
  const windowMs = end.at > start.at ? end.at - start.at : null;
  const coveredMs =
    windowMs === null ? null : Math.max(0, Math.min(stall.endedAt, end.at) - start.at);
  const seen =
    windowMs !== null &&
    coveredMs !== null &&
    coveredMs * 2 >= Math.max(windowMs, stall.durationMs);
  return { ...delta, windowMs, coveredMs, cause: seen ? classifyPause(delta, windowMs) : null };
};
