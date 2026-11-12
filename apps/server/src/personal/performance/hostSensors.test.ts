// @effect-diagnostics nodeBuiltinImport:off - the fixture is a real /sys-shaped tree.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeHostSensorReader, readHostSensors, type HostSensorIo } from "./hostSensors.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const fixture = (files: Record<string, string>): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "host-sensors-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = NodePath.join(root, path);
    NodeFS.mkdirSync(NodePath.dirname(full), { recursive: true });
    NodeFS.writeFileSync(full, content);
  }
  return root;
};

const laptop = () =>
  fixture({
    "class/hwmon/hwmon0/name": "coretemp",
    "class/hwmon/hwmon0/temp1_label": "Package id 0",
    "class/hwmon/hwmon0/temp1_input": "94000\n",
    "class/hwmon/hwmon1/name": "nvme",
    "class/hwmon/hwmon1/temp1_label": "Composite",
    "class/hwmon/hwmon1/temp1_input": "38850\n",
    "class/hwmon/hwmon2/name": "dell_ddv",
    "class/hwmon/hwmon2/fan1_label": "CPU Fan",
    "class/hwmon/hwmon2/fan1_input": "2812\n",
    "class/hwmon/hwmon2/fan2_label": "Chassis Motherboard Fan",
    "class/hwmon/hwmon2/fan2_input": "2418\n",
    "class/hwmon/hwmon3/name": "dell_smm",
    "class/hwmon/hwmon3/fan1_input": "2812\n",
    "class/hwmon/hwmon3/fan2_input": "2418\n",
    "class/thermal/thermal_zone0/type": "x86_pkg_temp\n",
    "class/thermal/thermal_zone0/temp": "93000\n",
  });

const LAPTOP_SENSORS = {
  cpuTempC: 94,
  diskTempC: 39,
  fans: [
    { label: "CPU Fan", rpm: 2812 },
    { label: "Chassis Motherboard Fan", rpm: 2418 },
  ],
} as const;

const countingIo = (paths: Array<string>): HostSensorIo => ({
  readdir: async (path) => {
    try {
      return await NodeFSP.readdir(path);
    } catch {
      return [];
    }
  },
  readFile: async (path) => {
    paths.push(path);
    try {
      return (await NodeFSP.readFile(path, "utf8")).trim();
    } catch {
      return null;
    }
  },
});

describe("readHostSensors", () => {
  it("reads the package temperature, the NVMe temperature and the labelled fans", async () => {
    expect(await readHostSensors(laptop())).toEqual(LAPTOP_SENSORS);
  });

  it("reports nothing on a machine with no hwmon tree", async () => {
    expect(
      await readHostSensors(fixture({ "class/thermal/thermal_zone0/type": "acpitz\n" })),
    ).toEqual({
      cpuTempC: null,
      diskTempC: null,
      fans: [],
    });
  });

  it("falls back to the thermal zone and hides an unlabelled or zero fan", async () => {
    const root = fixture({
      "class/thermal/thermal_zone2/type": "x86_pkg_temp\n",
      "class/thermal/thermal_zone2/temp": "74000\n",
      "class/hwmon/hwmon0/name": "dell_smm",
      "class/hwmon/hwmon0/fan1_input": "0\n",
      "class/hwmon/hwmon0/fan2_input": "900\n",
    });

    expect(await readHostSensors(root)).toEqual({
      cpuTempC: 74,
      diskTempC: null,
      fans: [],
    });
  });

  it("dedupes a repeated fan across chips", async () => {
    const root = fixture({
      "class/hwmon/hwmon0/name": "dell_ddv",
      "class/hwmon/hwmon0/fan1_label": "CPU Fan",
      "class/hwmon/hwmon0/fan1_input": "2812\n",
      "class/hwmon/hwmon0/fan2_label": "Chassis Fan",
      "class/hwmon/hwmon0/fan2_input": "2812\n",
      "class/hwmon/hwmon1/name": "other",
      "class/hwmon/hwmon1/fan1_label": "Duplicate Fan",
      "class/hwmon/hwmon1/fan1_input": "2812\n",
      "class/hwmon/hwmon1/fan2_label": "Rear Fan",
      "class/hwmon/hwmon1/fan2_input": "1100\n",
    });

    expect((await readHostSensors(root)).fans).toEqual([
      { label: "CPU Fan", rpm: 2812 },
      { label: "Rear Fan", rpm: 1100 },
    ]);
  });
});

describe("makeHostSensorReader", () => {
  it("does no reads inside the TTL and then reads only the chosen files", async () => {
    const root = laptop();
    const paths: Array<string> = [];
    const reader = makeHostSensorReader({ root, io: countingIo(paths), staleAfterMs: 5_000 });

    expect(await reader.read(0)).toEqual(LAPTOP_SENSORS);
    expect(reader.current()).toEqual(LAPTOP_SENSORS);

    paths.length = 0;
    expect(await reader.read(4_999)).toEqual(LAPTOP_SENSORS);
    expect(paths).toEqual([]);

    expect(await reader.read(5_000)).toEqual(LAPTOP_SENSORS);
    expect(paths.map((path) => NodePath.relative(root, path)).sort()).toEqual([
      "class/hwmon/hwmon0/temp1_input",
      "class/hwmon/hwmon1/temp1_input",
      "class/hwmon/hwmon2/fan1_input",
      "class/hwmon/hwmon2/fan2_input",
    ]);
  });

  it("keeps the last value and resolves again when a chosen file disappears", async () => {
    const root = laptop();
    const paths: Array<string> = [];
    const io = countingIo(paths);
    let hideCpu = false;
    const reader = makeHostSensorReader({
      root,
      io: {
        readdir: io.readdir,
        readFile: async (path) =>
          hideCpu && path.endsWith("hwmon0/temp1_input") ? null : io.readFile(path),
      },
      staleAfterMs: 5_000,
    });

    expect(await reader.read(0)).toEqual(LAPTOP_SENSORS);
    hideCpu = true;
    expect(await reader.read(5_000)).toEqual(LAPTOP_SENSORS);

    hideCpu = false;
    paths.length = 0;
    expect(await reader.read(10_000)).toEqual(LAPTOP_SENSORS);
    // The selection was resolved again: names and labels were read too.
    expect(paths.some((path) => path.endsWith("hwmon0/name"))).toBe(true);
  });
});
