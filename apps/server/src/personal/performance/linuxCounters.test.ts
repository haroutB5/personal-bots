import { describe, expect, it } from "@effect/vitest";

import {
  commandLineOf,
  cpuPercent,
  diskRates,
  netTables,
  parseDiskStats,
  parseMeminfo,
  parseNetDev,
  parsePidStat,
  parseProcStat,
  processCpuPercent,
  threadPercent,
} from "./linuxCounters.ts";

const procStat = (total: string, threads: ReadonlyArray<string>): string =>
  `cpu  ${total}\n${threads.map((line, index) => `cpu${index} ${line}`).join("\n")}\nintr 0\nbtime 1700000000\nprocesses 1\n`;

describe("linuxCounters", () => {
  it("reads the total, every thread and the boot time from /proc/stat", () => {
    const parsed = parseProcStat(procStat("100 0 50 800 50 0 0 0", ["10 0 5 80 5 0 0 0"]));
    expect(parsed.total).toEqual({ name: "cpu", busy: 150, total: 1000 });
    expect(parsed.threads).toEqual([{ name: "cpu0", busy: 15, total: 100 }]);
    expect(parsed.bootAtMs).toBe(1_700_000_000_000);
  });

  it("computes whole-machine and per-thread percentages from two readings", () => {
    const first = parseProcStat(procStat("100 0 0 100 0 0 0 0", ["10 0 0 10 0 0 0 0"]));
    const second = parseProcStat(procStat("150 0 0 150 0 0 0 0", ["20 0 0 20 0 0 0 0"]));
    expect(cpuPercent(first.total, second.total)).toBe(50);
    expect(threadPercent(first.threads, second.threads)).toEqual([["0,0", 50]]);
  });

  it("takes MemAvailable, not MemFree, as the free number", () => {
    expect(
      parseMeminfo("MemTotal:       16000000 kB\nMemFree:          500000 kB\nMemAvailable:    8000000 kB"),
    ).toEqual({ totalMB: 15_625, availableMB: 7_812.5 });
  });

  it("skips loop, partition and virtual devices when reading disk counters", () => {
    const text = [
      "   8       0 sda 1000 0 2000 50 1000 0 4000 60 0 90 110 0 0 0 0",
      "   8       1 sda1 1000 0 2000 50 1000 0 4000 60 0 90 110 0 0 0 0",
      " 259       0 nvme0n1 2000 0 10000 80 2000 0 20000 100 0 180 180 0 0 0 0",
      " 259       1 nvme0n1p1 2000 0 10000 80 2000 0 20000 100 0 180 180 0 0 0 0",
      "   7       0 loop0 1 0 1 1 1 0 1 1 0 1 2 0 0 0 0",
    ].join("\n");
    const parsed = parseDiskStats(text);
    expect([...parsed.keys()]).toEqual(["sda", "nvme0n1"]);
    expect(parsed.get("nvme0n1")).toEqual({
      readSectors: 10_000,
      writtenSectors: 20_000,
      ioTimeMs: 180,
    });
  });

  it("turns two disk readings into throughput and busy percent", () => {
    const previous = parseDiskStats(
      " 259 0 nvme0n1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0",
    );
    // major minor name reads merged sectorsRead msReading writes merged
    // sectorsWritten msWriting inProgress io_ticks weighted
    const next = parseDiskStats(" 259 0 nvme0n1 0 0 2000 0 0 0 4000 0 0 500 0 0 0 0");
    const rates = diskRates(previous, next, 2_000);
    expect(rates).not.toBeNull();
    // 2000 sectors * 512 bytes over 2 s.
    expect(rates?.readBps).toBe(512_000);
    expect(rates?.writeBps).toBe(1_024_000);
    expect(rates?.activePct).toBe(25);
  });

  it("reads interface counters and leaves loopback out", () => {
    const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0
  wlan0: 5000 1 0 0 0 0 0 0 3000 1 0 0 0 0 0 0
`;
    const parsed = parseNetDev(text);
    expect(parsed).toEqual([{ name: "wlan0", rxBytes: 5000, txBytes: 3000 }]);
    const tables = netTables(
      parsed,
      [{ name: "wlan0", rxBytes: 7000, txBytes: 4000 }],
      2_000,
    );
    expect(tables.rx).toEqual([["wlan0", 1_000]]);
    expect(tables.tx).toEqual([["wlan0", 500]]);
  });

  it("reads a process stat whose name has spaces and parentheses", () => {
    const text =
      '4321 (Web Content (abc)) S 1234 4321 4321 0 -1 4194304 100 0 0 0 25 15 0 0 20 0 4 0 999 123456 3000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
    const parsed = parsePidStat(text);
    expect(parsed).toEqual({
      pid: 4321,
      name: "Web Content (abc)",
      parentPid: 1234,
      cpuTicks: 40,
      rssPages: 3000,
    });
  });

  it("never reports a negative or first-sample CPU percent", () => {
    expect(processCpuPercent(undefined, 100, 2_000)).toBe(0);
    expect(processCpuPercent(100, 120, 2_000)).toBe(10);
    expect(processCpuPercent(120, 100, 2_000)).toBe(0);
  });

  it("flattens a null-separated cmdline", () => {
    expect(commandLineOf("node\u0000--session-id\u0000abc\u0000")).toBe("node --session-id abc");
  });
});
