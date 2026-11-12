import { describe, expect, it } from "vite-plus/test";

import { machineStatRows, parseSystemSummary } from "./systemStats.ts";

describe("parseSystemSummary", () => {
  it("fills the sensor fields from a new server", () => {
    expect(
      parseSystemSummary({
        cpuPct: 42,
        memUsedPct: 58,
        memUsedGB: 9.1,
        memTotalGB: 15.6,
        diskLabel: "C:",
        diskFreeGB: 120,
        diskTotalGB: 500,
        cpuTempC: 94,
        diskTempC: 38.9,
        fans: [
          { label: "CPU Fan", rpm: 2812 },
          { label: "Chassis Motherboard Fan", rpm: 2418 },
        ],
      }),
    ).toEqual({
      cpuPct: 42,
      memUsedPct: 58,
      memUsedGB: 9.1,
      memTotalGB: 15.6,
      diskLabel: "C:",
      diskFreeGB: 120,
      diskTotalGB: 500,
      cpuTempC: 94,
      diskTempC: 38.9,
      fans: [
        { label: "CPU Fan", rpm: 2812 },
        { label: "Chassis Motherboard Fan", rpm: 2418 },
      ],
    });
  });

  it("reads an old server as no sensors and no fans", () => {
    const parsed = parseSystemSummary({ cpuPct: 3, diskFreeGB: 20 });

    expect(parsed?.cpuTempC).toBeNull();
    expect(parsed?.diskTempC).toBeNull();
    expect(parsed?.fans).toEqual([]);
  });

  it("drops a fan with no label or no reading", () => {
    const parsed = parseSystemSummary({
      fans: [
        { label: "CPU Fan", rpm: 2812 },
        { label: "", rpm: 900 },
        { label: "Chassis", rpm: 0 },
        { label: "Broken" },
        null,
      ],
    });

    expect(parsed?.fans).toEqual([{ label: "CPU Fan", rpm: 2812 }]);
  });
});

describe("machineStatRows", () => {
  it("draws every sensor the host has, in card order", () => {
    const rows = machineStatRows({
      cpuPct: 42,
      memUsedPct: 58,
      memUsedGB: 9.1,
      memTotalGB: 15.6,
      diskLabel: "/",
      diskFreeGB: 120,
      diskTotalGB: 500,
      cpuTempC: 94,
      diskTempC: 38.9,
      fans: [
        { label: "CPU Fan", rpm: 2812 },
        { label: "Chassis Motherboard Fan", rpm: 2418 },
      ],
    });

    expect(rows).toEqual([
      { key: "cpu", label: "CPU", value: "42%" },
      { key: "memory", label: "Memory", value: "9.1 of 15.6 GB" },
      { key: "disk", label: "Disk", value: "120 GB free" },
      { key: "cpuTemp", label: "CPU temperature", value: "94 °C" },
      { key: "diskTemp", label: "Disk temperature", value: "39 °C" },
      { key: "fan:0", label: "CPU Fan", value: "2,812 rpm" },
      { key: "fan:1", label: "Chassis Motherboard Fan", value: "2,418 rpm" },
    ]);
  });

  it("hides temperature and fan rows on a host without those sensors", () => {
    const rows = machineStatRows({
      cpuPct: 7,
      memUsedPct: 20,
      memUsedGB: 3.1,
      memTotalGB: 15.6,
      diskLabel: null,
      diskFreeGB: null,
      diskTotalGB: null,
      cpuTempC: null,
      diskTempC: null,
      fans: [],
    });

    expect(rows).toEqual([
      { key: "cpu", label: "CPU", value: "7%" },
      { key: "memory", label: "Memory", value: "3.1 of 15.6 GB" },
    ]);
  });
});
