/**
 * The host's temperatures and fans, read straight from `/sys`: no package, no
 * sudo, no sampler. A machine without a sensor reports null or no fan, never a
 * zero. Cached by the summary route, because these files move slowly.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface HostSensorFan {
  readonly label: string;
  readonly rpm: number;
}

export interface HostSensors {
  readonly cpuTempC: number | null;
  readonly diskTempC: number | null;
  readonly fans: ReadonlyArray<HostSensorFan>;
}

export const NO_HOST_SENSORS: HostSensors = { cpuTempC: null, diskTempC: null, fans: [] };

interface ChipTemperature {
  readonly label: string | null;
  readonly milliC: number;
}

interface ChipFan {
  readonly label: string | null;
  readonly rpm: number;
}

interface HwmonChip {
  readonly name: string;
  readonly temperatures: ReadonlyArray<ChipTemperature>;
  readonly fans: ReadonlyArray<ChipFan>;
}

const text = (path: string): string | null => {
  try {
    return NodeFS.readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
};

const numberOrNull = (value: string | null): number | null => {
  if (value === null || value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const directories = (path: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(path)
      .filter((entry) => entry.startsWith("hwmon") || entry.startsWith("thermal_zone"))
      .sort((left, right) =>
        left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }),
      )
      .map((entry) => NodePath.join(path, entry));
  } catch {
    return [];
  }
};

const readChip = (directory: string): HwmonChip | null => {
  const name = text(NodePath.join(directory, "name"));
  if (name === null || name.length === 0) return null;
  const temperatures: ChipTemperature[] = [];
  const fans: ChipFan[] = [];
  for (const entry of NodeFS.readdirSync(directory).sort()) {
    const temperature = /^temp(\d+)_input$/.exec(entry);
    if (temperature !== null) {
      const milliC = numberOrNull(text(NodePath.join(directory, entry)));
      if (milliC !== null) {
        temperatures.push({
          label: text(NodePath.join(directory, `temp${temperature[1]}_label`)),
          milliC,
        });
      }
      continue;
    }
    const fan = /^fan(\d+)_input$/.exec(entry);
    if (fan !== null) {
      const rpm = numberOrNull(text(NodePath.join(directory, entry)));
      if (rpm !== null) {
        fans.push({ label: text(NodePath.join(directory, `fan${fan[1]}_label`)), rpm });
      }
    }
  }
  return { name, temperatures, fans };
};

const readChips = (root: string): ReadonlyArray<HwmonChip> =>
  directories(NodePath.join(root, "class", "hwmon")).flatMap((directory) => {
    try {
      const chip = readChip(directory);
      return chip === null ? [] : [chip];
    } catch {
      return [];
    }
  });

const labelIs = (label: string | null, wanted: string) =>
  label !== null && label.trim().toLowerCase() === wanted.toLowerCase();

const chipHasName = (chip: HwmonChip, wanted: string) =>
  chip.name.trim().toLowerCase() === wanted.toLowerCase();

const toCelsius = (milliC: number): number => Math.round(milliC / 1000);

function cpuTempC(chips: ReadonlyArray<HwmonChip>, root: string): number | null {
  const packageTemp = chips
    .filter((chip) => chipHasName(chip, "coretemp"))
    .flatMap((chip) => chip.temperatures)
    .find((temperature) => labelIs(temperature.label, "Package id 0"));
  if (packageTemp !== undefined) return toCelsius(packageTemp.milliC);

  const tctl = chips
    .filter((chip) => chipHasName(chip, "k10temp"))
    .flatMap((chip) => chip.temperatures)
    .find((temperature) => labelIs(temperature.label, "Tctl"));
  if (tctl !== undefined) return toCelsius(tctl.milliC);

  const zone = directories(NodePath.join(root, "class", "thermal")).find(
    (directory) => text(NodePath.join(directory, "type")) === "x86_pkg_temp",
  );
  if (zone !== undefined) {
    const milliC = numberOrNull(text(NodePath.join(zone, "temp")));
    if (milliC !== null) return toCelsius(milliC);
  }

  const tcpu = chips.find((chip) => chipHasName(chip, "TCPU"));
  const first = tcpu?.temperatures[0];
  return first === undefined ? null : toCelsius(first.milliC);
}

function diskTempC(chips: ReadonlyArray<HwmonChip>): number | null {
  const composite = chips
    .filter((chip) => chipHasName(chip, "nvme"))
    .flatMap((chip) => chip.temperatures)
    .find((temperature) => labelIs(temperature.label, "Composite"));
  if (composite !== undefined) return toCelsius(composite.milliC);

  const drivetemp = chips.find((chip) => chipHasName(chip, "drivetemp"));
  const first = drivetemp?.temperatures[0];
  return first === undefined ? null : toCelsius(first.milliC);
}

function fans(chips: ReadonlyArray<HwmonChip>): ReadonlyArray<HostSensorFan> {
  const labelled = chips
    .map((chip) => chip.fans.filter((fan) => fan.label !== null && fan.label.trim().length > 0))
    .filter((chipFans) => chipFans.length > 0);
  const collected: HostSensorFan[] = [];
  for (const chipFans of labelled) {
    for (const fan of chipFans) {
      const label = fan.label?.trim() ?? "";
      if (fan.rpm <= 0 || label.length === 0) continue;
      if (collected.some((kept) => kept.rpm === fan.rpm)) continue;
      collected.push({ label, rpm: fan.rpm });
      if (collected.length === 4) return collected;
    }
  }
  return collected;
}

/** Reads `/sys` (or a fixture root shaped like it). Empty everywhere off Linux. */
export function readHostSensors(root = "/sys"): HostSensors {
  try {
    const chips = readChips(root);
    return {
      cpuTempC: cpuTempC(chips, root),
      diskTempC: diskTempC(chips),
      fans: fans(chips),
    };
  } catch {
    return NO_HOST_SENSORS;
  }
}
