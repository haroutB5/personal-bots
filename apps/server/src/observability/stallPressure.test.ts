import { describe, expect, it } from "vite-plus/test";

import {
  classifyPause,
  measureStallPressure,
  type PressureCounts,
  type PressureFiles,
} from "./stallPressure.ts";

const taskStat = (
  minflt: number,
  majflt: number,
  utime: number,
  stime: number,
  name = "MainThread",
) =>
  `1815778 (${name}) S 900 1815778 1815778 0 -1 4194304 ${minflt} 0 ${majflt} 0 ${utime} ${stime} 0 0 20 0 11 0 5113520 1386070016 77066\n`;

const memoryStat = (
  pswpin: number,
  pswpout: number,
  pgmajfault: number,
  anon: number,
  file: number,
) =>
  [
    "anon 391897088",
    "file 120320000",
    `workingset_refault_anon ${anon}`,
    `workingset_refault_file ${file}`,
    "workingset_activate_anon 1",
    `pswpin ${pswpin}`,
    `pswpout ${pswpout}`,
    "pgfault 9934133",
    `pgmajfault ${pgmajfault}`,
    "",
  ].join("\n");

const pressure = (someUs: number) =>
  `some avg10=0.00 avg60=0.00 avg300=0.76 total=${someUs}\nfull avg10=0.00 avg60=0.00 avg300=0.76 total=${someUs - 7}\n`;

const start: PressureFiles = {
  at: 1_000_000,
  taskStat: taskStat(5364, 120, 300, 40),
  taskSchedstat: "118072165 6546134 1417\n",
  memoryStat: memoryStat(722_492, 818_834, 732_158, 728_167, 457_850),
  memoryPressure: pressure(2_711_837),
  ioPressure: pressure(89_935_972),
  cpuPressure: pressure(3_454_902),
};

const end: PressureFiles = {
  at: 1_002_000,
  taskStat: taskStat(5900, 520, 305, 90),
  taskSchedstat: "118572165 106546134 1500\n",
  memoryStat: memoryStat(722_892, 818_834, 732_568, 728_557, 457_850),
  memoryPressure: pressure(4_211_837),
  ioPressure: pressure(89_955_972),
  cpuPressure: pressure(3_457_902),
};

const wholeStall = { endedAt: 1_002_000, durationMs: 2000 };

const unread = (at: number): PressureFiles => ({
  at,
  taskStat: null,
  taskSchedstat: null,
  memoryStat: null,
  memoryPressure: null,
  ioPressure: null,
  cpuPressure: null,
});

const nothing: PressureCounts = {
  mainMajflt: null,
  mainMinflt: null,
  mainUserMs: null,
  mainSystemMs: null,
  mainRunqWaitMs: null,
  pswpin: null,
  pswpout: null,
  pgmajfault: null,
  workingsetRefaultAnon: null,
  workingsetRefaultFile: null,
  memorySomeMs: null,
  ioSomeMs: null,
  cpuSomeMs: null,
};

describe("measureStallPressure", () => {
  it("turns two readings into deltas in counts and ms, with a swap-in verdict", () => {
    expect(measureStallPressure(start, end, wholeStall)).toEqual({
      mainMajflt: 400,
      mainMinflt: 536,
      mainUserMs: 50,
      mainSystemMs: 500,
      mainRunqWaitMs: 100,
      pswpin: 400,
      pswpout: 0,
      pgmajfault: 410,
      workingsetRefaultAnon: 390,
      workingsetRefaultFile: 0,
      memorySomeMs: 1500,
      ioSomeMs: 20,
      cpuSomeMs: 3,
      windowMs: 2000,
      coveredMs: 2000,
      cause: "swap-in",
    });
  });

  it("gives null fields and no verdict when no file could be read", () => {
    expect(measureStallPressure(unread(1_000_000), unread(1_002_000), wholeStall)).toEqual({
      ...nothing,
      windowMs: 2000,
      coveredMs: 2000,
      cause: null,
    });
  });

  it("keeps the main-thread numbers when the cgroup files are missing, and withholds a verdict that needs them", () => {
    const noUnit = (files: PressureFiles): PressureFiles => ({
      ...files,
      memoryStat: null,
      memoryPressure: null,
      ioPressure: null,
      cpuPressure: null,
    });
    expect(measureStallPressure(noUnit(start), noUnit(end), wholeStall)).toEqual({
      ...nothing,
      mainMajflt: 400,
      mainMinflt: 536,
      mainUserMs: 50,
      mainSystemMs: 500,
      mainRunqWaitMs: 100,
      windowMs: 2000,
      coveredMs: 2000,
      cause: null,
    });
  });

  it("reads null from text it cannot parse", () => {
    const garbled: PressureFiles = {
      at: 1_002_000,
      taskStat: "no parens here 1 2 3",
      taskSchedstat: "",
      memoryStat: "pswpin many\npgmajfault -3\n",
      memoryPressure: "full avg10=0.00 total=5\n",
      ioPressure: "some total=abc\n",
      cpuPressure: "",
    };
    expect(measureStallPressure(start, garbled, wholeStall)).toEqual({
      ...nothing,
      windowMs: 2000,
      coveredMs: 2000,
      cause: null,
    });
  });

  it("finds the fields after a thread name that holds spaces and parens", () => {
    const named = (files: PressureFiles, minflt: number, majflt: number): PressureFiles => ({
      ...files,
      taskStat: taskStat(minflt, majflt, 300, 40, "a) b (c"),
    });
    const result = measureStallPressure(named(start, 100, 7), named(end, 160, 9), wholeStall);
    expect([result.mainMinflt, result.mainMajflt]).toEqual([60, 2]);
  });

  it("drops a counter that went backwards instead of reporting a negative delta", () => {
    const result = measureStallPressure(
      end,
      { ...start, at: 1_004_000 },
      {
        endedAt: 1_004_000,
        durationMs: 2000,
      },
    );
    expect([result.pswpin, result.mainMajflt, result.windowMs]).toEqual([null, null, 2000]);
  });
});

describe("a 1150 ms JavaScript spin (Verifier 2, 3b)", () => {
  const reading = (at: number, utime: number): PressureFiles => ({
    ...start,
    at,
    taskStat: taskStat(5364, 120, utime, 40),
  });
  const spin = { durationMs: 1150 };

  it("gives no verdict when the first reading came after most of the stall", () => {
    const result = measureStallPressure(reading(1_000_000, 300), reading(1_000_350, 310), {
      ...spin,
      endedAt: 1_000_100,
    });
    expect([result.mainUserMs, result.windowMs, result.coveredMs, result.cause]).toEqual([
      100,
      350,
      100,
      null,
    ]);
  });

  it("says running when the first reading came early in the stall", () => {
    const result = measureStallPressure(reading(1_000_000, 300), reading(1_000_950, 370), {
      ...spin,
      endedAt: 1_000_700,
    });
    expect([result.mainUserMs, result.windowMs, result.coveredMs, result.cause]).toEqual([
      700,
      950,
      700,
      "running",
    ]);
  });
});

describe("classifyPause", () => {
  const quiet: PressureCounts = {
    mainMajflt: 0,
    mainMinflt: 10,
    mainUserMs: 20,
    mainSystemMs: 10,
    mainRunqWaitMs: 30,
    pswpin: 0,
    pswpout: 0,
    pgmajfault: 0,
    workingsetRefaultAnon: 0,
    workingsetRefaultFile: 0,
    memorySomeMs: 0,
    ioSomeMs: 0,
    cpuSomeMs: 0,
  };
  const faulting = { ...quiet, mainMajflt: 300 };

  it.each<[string, Partial<PressureCounts>, ReturnType<typeof classifyPause>]>([
    ["the thread ran user code most of the window", { mainUserMs: 1500 }, "running"],
    ["it waited on the run queue most of the window", { mainRunqWaitMs: 1200 }, "cpu"],
    [
      "many major faults, nearly all the unit's, each matched by a swap-in",
      { ...faulting, pgmajfault: 310, pswpin: 300 },
      "swap-in",
    ],
    [
      "many major faults while nothing in the unit came from swap",
      { ...faulting, pgmajfault: 300 },
      "disk",
    ],
    [
      "swap-ins in the unit, but other tasks made half its major faults",
      { ...faulting, pgmajfault: 600, pswpin: 300 },
      null,
    ],
    [
      "memory.stat not yet flushed: fewer unit faults than main-thread faults",
      { ...faulting, pgmajfault: 120 },
      null,
    ],
    ["many faults and memory.stat unreadable", { ...faulting, pswpin: null }, null],
    [
      "kernel time most of the window, the unit stalled on memory for most of it",
      { mainSystemMs: 1200, memorySomeMs: 900 },
      "reclaim",
    ],
    [
      "kernel time most of the window, memory stall under half of it",
      { mainSystemMs: 1490, memorySomeMs: 421 },
      "kernel",
    ],
    [
      "kernel time most of the window and memory.pressure unreadable",
      { mainSystemMs: 1490, memorySomeMs: null },
      null,
    ],
    ["off CPU most of the window: a wait of its own", {}, "blocked"],
    ["off CPU most of the window, memory.pressure unreadable", { memorySomeMs: null }, "blocked"],
    ["main thread stat unreadable", { mainMajflt: null }, null],
  ])("%s", (_label, change, cause) => {
    expect(classifyPause({ ...quiet, ...change }, 2000)).toBe(cause);
  });

  it.each<[string, Partial<PressureCounts>, ReturnType<typeof classifyPause>]>([
    [
      "3a, a readSync loop on /dev/zero",
      { mainUserMs: 250, mainSystemMs: 1460, mainRunqWaitMs: 20 },
      "kernel",
    ],
  ])("Verifier 2 %s, window 1752 ms", (_label, change, cause) => {
    expect(classifyPause({ ...quiet, ...change }, 1752)).toBe(cause);
  });

  it.each<[string, Partial<PressureCounts>, ReturnType<typeof classifyPause>]>([
    ["3c, user code and run-queue wait", { mainUserMs: 450, mainRunqWaitMs: 450 }, null],
    ["3d, user and kernel time, no pressure", { mainUserMs: 400, mainSystemMs: 450 }, null],
    [
      "3e, file faults on the main thread, one swap-in elsewhere",
      { mainMajflt: 60, pgmajfault: 61, pswpin: 1 },
      null,
    ],
    [
      "3f, main thread in fsync, a child stalled on memory",
      { mainUserMs: 20, mainSystemMs: 10, mainRunqWaitMs: 30, memorySomeMs: 300 },
      "blocked",
    ],
  ])("Verifier 2 %s, window 1000 ms", (_label, change, cause) => {
    expect(classifyPause({ ...quiet, ...change }, 1000)).toBe(cause);
  });

  it("gives no verdict for an empty window", () => {
    expect(classifyPause({ ...quiet, mainUserMs: 1500 }, 0)).toBeNull();
  });
});
