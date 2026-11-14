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
    expect(measureStallPressure(start, end)).toEqual({
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
      cause: "swap-in",
    });
  });

  it("gives null fields and no verdict when no file could be read", () => {
    expect(measureStallPressure(unread(1_000_000), unread(1_002_000))).toEqual({
      ...nothing,
      windowMs: 2000,
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
    expect(measureStallPressure(noUnit(start), noUnit(end))).toEqual({
      ...nothing,
      mainMajflt: 400,
      mainMinflt: 536,
      mainUserMs: 50,
      mainSystemMs: 500,
      mainRunqWaitMs: 100,
      windowMs: 2000,
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
    expect(measureStallPressure(start, garbled)).toEqual({
      ...nothing,
      windowMs: 2000,
      cause: null,
    });
  });

  it("finds the fields after a thread name that holds spaces and parens", () => {
    const named = (files: PressureFiles, minflt: number, majflt: number): PressureFiles => ({
      ...files,
      taskStat: taskStat(minflt, majflt, 300, 40, "a) b (c"),
    });
    const result = measureStallPressure(named(start, 100, 7), named(end, 160, 9));
    expect([result.mainMinflt, result.mainMajflt]).toEqual([60, 2]);
  });

  it("drops a counter that went backwards instead of reporting a negative delta", () => {
    const result = measureStallPressure(end, { ...start, at: 1_004_000 });
    expect([result.pswpin, result.mainMajflt, result.windowMs]).toEqual([null, null, 2000]);
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
    ["many major faults with swap-ins", { ...faulting, pswpin: 280 }, "swap-in"],
    ["many major faults with file refaults", { ...faulting, workingsetRefaultFile: 90 }, "disk"],
    ["many major faults under I/O pressure", { ...faulting, ioSomeMs: 400 }, "disk"],
    ["many major faults with no swap or disk sign", faulting, "reclaim"],
    [
      "few faults but kernel time most of the window",
      { mainSystemMs: 1490, memorySomeMs: 421 },
      "reclaim",
    ],
    [
      "few faults but memory pressure over a quarter of the window",
      { memorySomeMs: 900 },
      "reclaim",
    ],
    ["few faults and no pressure: a wait of its own", {}, "blocked"],
    ["main thread stat unreadable", { mainMajflt: null }, null],
    ["many faults and memory.stat unreadable", { ...faulting, pswpin: null }, null],
    ["few faults and memory.pressure unreadable", { memorySomeMs: null }, null],
  ])("%s", (_label, change, cause) => {
    expect(classifyPause({ ...quiet, ...change }, 2000)).toBe(cause);
  });

  it("gives no verdict for an empty window", () => {
    expect(classifyPause({ ...quiet, mainUserMs: 1500 }, 0)).toBeNull();
  });
});
