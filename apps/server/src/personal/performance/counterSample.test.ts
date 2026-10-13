import { describe, expect, it } from "@effect/vitest";

import {
  busiestAdapter,
  clockGHz,
  gpuBusy,
  parseHelperHello,
  parseHelperTick,
  threadPct,
} from "./counterSample.ts";

describe("parseHelperHello", () => {
  it("reads the one-time machine facts", () => {
    const hello = parseHelperHello(
      '{"kind":"hello","hv":1,"memTotalMB":16069,"pcBootAt":1791595959500,' +
        '"model":"Inspiron 16 Plus 7620","cpuName":"12th Gen Intel(R) Core(TM) i7-12700H",' +
        '"physCores":14,"logicalProcessors":20,"maxClockMHz":2300,"gpuName":"Intel(R) Iris(R) Xe Graphics"}',
    );
    expect(hello).not.toBeNull();
    expect(hello?.memTotalMB).toBe(16069);
    expect(hello?.logicalProcessors).toBe(20);
    expect(hello?.maxClockMHz).toBe(2300);
    expect(hello?.model).toBe("Inspiron 16 Plus 7620");
  });

  it("rejects anything that is not a hello line", () => {
    expect(parseHelperHello('{"t":1,"c":{}}')).toBeNull();
    expect(parseHelperHello("not json")).toBeNull();
  });
});

const TICK_LINE =
  '{"t":1791851909833,"ms":9,"c":{"cpuUtility":9.65,"cpuPerformance":121.41,' +
  '"memAvailableMB":4783,"diskIdlePct":96.96,"diskReadBps":0,"diskWriteBps":400808.52,' +
  '"threads":[["0,0",4.5],["0,1",0.1],["0,_Total",9.65]],' +
  '"gpu":[["pid_10264_luid_0x0_phys_0_eng_0_engtype_3D",0.1],' +
  '["pid_10264_luid_0x0_phys_0_eng_1_engtype_3D",0.2],' +
  '["pid_9012_luid_0x0_phys_0_eng_0_engtype_VideoDecode",1.4],' +
  '["pid_10264_luid_0x0_phys_0_eng_9_engtype_",0.3]],' +
  '"netRx":[["Wi-Fi",2781.34],["Bluetooth Network Connection",0]],' +
  '"netTx":[["Wi-Fi",123.4],["Bluetooth Network Connection",0]],' +
  '"proc":[["_Total",350,1,0],["Idle",340,2,0],["System",1.2,500000,4],' +
  '["chrome",3.4,402653184,1234],["claude",12.5,536870912,2222],["claude#1",1,1000,3333]]},' +
  '"k":[{"pid":10136,"name":"claude.exe","cpu100ns":123,"wsBytes":10,"cmd":"claude.EXE --session-id=abc"}],' +
  '"pp":[[1234,15000,1],[2222,15000,1],[3333,2222,1]],' +
  '"s":{"batteryPct":100,"batteryState":"full","batteryMinutesLeft":null,"diskTotalGB":512.1,"diskFreeGB":132.7}}';

describe("parseHelperTick", () => {
  it("reads counters, processes, children, parents and the slow block", () => {
    const tick = parseHelperTick(TICK_LINE);
    expect(tick).not.toBeNull();
    expect(tick?.cpuUtility).toBe(9.65);
    expect(tick?.memAvailableMB).toBe(4783);
    expect(tick?.processes.length).toBe(6);
    expect(tick?.children[0]?.name).toBe("claude.exe");
    expect(tick?.parents?.length).toBe(3);
    expect(tick?.slow?.batteryState).toBe("full");
    expect(tick?.slow?.diskFreeGB).toBe(132.7);
  });

  it("keeps a tick without parents and slow (most ticks have neither)", () => {
    const bare = '{"t":1,"ms":2,"c":{"cpuUtility":5},"k":[]}';
    const tick = parseHelperTick(bare);
    expect(tick?.parents).toBeNull();
    expect(tick?.slow).toBeNull();
    expect(tick?.processes).toEqual([]);
  });

  it("drops a malformed line, never guesses", () => {
    expect(parseHelperTick("{oops")).toBeNull();
    expect(parseHelperTick('{"t":1}')).toBeNull();
  });
});

describe("threadPct", () => {
  it("orders 0..n-1 and drops _Total", () => {
    const threads = Array.from({ length: 20 }, (_, i) => [`0,${i}`, i + 0.05] as const);
    const withTotal = [...threads, ["0,_Total", 50.2] as const];
    const out = threadPct(withTotal, 20);
    expect(out?.length).toBe(20);
    expect(out?.[0]).toBe(0.1);
    expect(out?.[19]).toBe(19.1);
  });

  it("is null when any thread has no value", () => {
    const threads = Array.from({ length: 19 }, (_, i) => [`0,${i}`, 1] as const);
    expect(threadPct(threads, 20)).toBeNull();
  });
});

describe("gpuBusy", () => {
  it("sums per engine type and takes the busiest type", () => {
    const gpu = gpuBusy([
      ["pid_1_luid_0x0_phys_0_eng_0_engtype_3D", 0.1],
      ["pid_1_luid_0x0_phys_0_eng_1_engtype_3D", 0.2],
      ["pid_2_luid_0x0_phys_0_eng_0_engtype_VideoDecode", 1.4],
      ["pid_2_luid_0x0_phys_0_eng_9_engtype_", 9.9],
    ]);
    expect(gpu).toEqual({ pct: 1.4, engine: "VideoDecode" });
  });

  it("is null when nothing uses the GPU", () => {
    expect(gpuBusy([["pid_1_luid_0x0_phys_0_eng_0_engtype_3D", 0]])).toBeNull();
    expect(gpuBusy([])).toBeNull();
  });
});

describe("busiestAdapter", () => {
  it("picks the adapter with the most combined traffic", () => {
    const adapter = busiestAdapter(
      [
        ["Wi-Fi", 2781.34],
        ["Bluetooth Network Connection", 0],
      ],
      [
        ["Wi-Fi", 123.4],
        ["Bluetooth Network Connection", 0],
      ],
    );
    expect(adapter?.name).toBe("Wi-Fi");
    expect(adapter?.downBps).toBe(2781.34);
    expect(adapter?.upBps).toBe(123.4);
  });
});

describe("clockGHz", () => {
  it("scales the nominal clock by % Processor Performance", () => {
    expect(clockGHz(121.41, 2300)).toBe(2.8);
    expect(clockGHz(100, 2300)).toBe(2.3);
    expect(clockGHz(null, 2300)).toBeNull();
    expect(clockGHz(96, null)).toBe(2.2);
  });
});
