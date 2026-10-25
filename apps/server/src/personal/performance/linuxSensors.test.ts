// @effect-diagnostics nodeBuiltinImport:off - the fixture writes sysfs-shaped files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { LinuxSensorReader, readLinuxBattery } from "./linuxSensors.ts";

/** A tiny sysfs tree shaped like this laptop's: coretemp, nvme, dell_smm. */
function fakeSysfs(): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-sysfs-"));
  const write = (relative: string, text: string) => {
    const file = NodePath.join(root, relative);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, text);
  };
  write("class/hwmon/hwmon0/name", "coretemp\n");
  write("class/hwmon/hwmon0/temp1_label", "Package id 0\n");
  write("class/hwmon/hwmon0/temp1_input", "61000\n");
  write("class/hwmon/hwmon0/temp2_label", "Core 0\n");
  write("class/hwmon/hwmon0/temp2_input", "59000\n");
  write("class/hwmon/hwmon1/name", "nvme\n");
  write("class/hwmon/hwmon1/temp1_label", "Composite\n");
  write("class/hwmon/hwmon1/temp1_input", "38500\n");
  write("class/hwmon/hwmon2/name", "dell_smm\n");
  write("class/hwmon/hwmon2/fan1_input", "2400\n");
  write("class/hwmon/hwmon2/fan2_input", "2500\n");
  write("class/power_supply/BAT0/capacity", "72\n");
  write("class/power_supply/BAT0/status", "Discharging\n");
  write("class/power_supply/BAT0/power_now", "9500000\n");
  write("class/power_supply/BAT0/energy_now", "38000000\n");
  write("class/power_supply/BAT0/energy_full", "54000000\n");
  write("class/power_supply/BAT0/energy_full_design", "60000000\n");
  return root;
}

describe("linuxSensors", () => {
  it("reads the package and SSD temperatures, both fans and the battery", () => {
    const root = fakeSysfs();
    const reading = new LinuxSensorReader({ sysRoot: root }).read(1_000);
    expect(reading.lhm).toBe("ok");
    expect(reading.sensors.cpuTempC).toBe(61);
    // P/E core strips are a LibreHardwareMonitor detail the kernel does not
    // expose; they stay null instead of being guessed at.
    expect(reading.sensors.pCoreC).toBeNull();
    expect(reading.sensors.eCoreC).toBeNull();
    expect(reading.sensors.ssdC).toBe(38.5);
    expect(reading.fans).toBe("ok");
    expect(reading.fan).toEqual({ status: "ok", fan1Rpm: 2400, fan2Rpm: 2500 });
    expect(reading.sensors.batteryRateW).toBe(9.5);
    expect(reading.sensors.batteryFullWh).toBe(54);
    expect(reading.sensors.batteryDesignWh).toBe(60);
    NodeFS.rmSync(root, { force: true, recursive: true });
  });

  it("is calm on a machine with no hwmon at all", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-empty-"));
    const reading = new LinuxSensorReader({ sysRoot: root }).read();
    expect(reading.lhm).toBe("down");
    expect(reading.sensors.cpuTempC).toBeNull();
    expect(reading.fans).toBe("ok");
    expect(reading.fan.status).toBe("unavailable");
    NodeFS.rmSync(root, { force: true, recursive: true });
  });

  it("computes the battery's remaining time from energy over power", () => {
    const root = fakeSysfs();
    const battery = readLinuxBattery(root);
    expect(battery.pct).toBe(72);
    expect(battery.state).toBe("discharging");
    // 38 Wh left at 9.5 W is 4 hours.
    expect(battery.minutesLeft).toBe(240);
    NodeFS.rmSync(root, { force: true, recursive: true });
  });

  // The RAPL directory is named `intel-rapl:0`; a colon cannot exist in a
  // Windows file name, so this fixture is POSIX-only (the reader is Linux-only).
  it.skipIf(process.platform === "win32")("turns a wrapping RAPL counter into watts", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-rapl-"));
    const dir = NodePath.join(root, "class/powercap/intel-rapl/intel-rapl:0");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "name"), "package-0\n");
    NodeFS.writeFileSync(NodePath.join(dir, "max_energy_range_uj"), "262143328850\n");
    NodeFS.writeFileSync(NodePath.join(dir, "energy_uj"), "1000000\n");
    const reader = new LinuxSensorReader({ sysRoot: root });
    const first = reader.read(1_000);
    // No previous reading yet: a rate needs two points.
    expect(first.sensors.powerCpuW).toBeNull();
    NodeFS.writeFileSync(NodePath.join(dir, "energy_uj"), "11000000\n");
    const second = reader.read(3_000);
    // 10 J over 2 s.
    expect(second.sensors.powerCpuW).toBe(5);
    // The counter wrapped past its maximum: still a reading, never negative.
    NodeFS.writeFileSync(NodePath.join(dir, "energy_uj"), "1000000\n");
    expect(reader.read(5_000).sensors.powerCpuW).toBeGreaterThanOrEqual(0);
    NodeFS.rmSync(root, { force: true, recursive: true });
  });
});
