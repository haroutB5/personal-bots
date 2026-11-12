/**
 * The host's temperatures and fans, read straight from `/sys`: no package, no
 * sudo, no sampler. A machine without a sensor reports null or no fan, never a
 * zero.
 *
 * Resolution (the package temperature file, the NVMe temperature file and the
 * labelled fan inputs) happens once and is cached for the process lifetime.
 * Each refresh then reads only those files, asynchronously. The summary route
 * serves the last value and revalidates in the background, so a request never
 * waits on `/sys`.
 */
import * as NodeFSP from "node:fs/promises";
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

/** The two async file operations, injectable so tests can count reads. */
export interface HostSensorIo {
  readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
  readonly readFile: (path: string) => Promise<string | null>;
}

const nodeIo: HostSensorIo = {
  readdir: async (path) => {
    try {
      return await NodeFSP.readdir(path);
    } catch {
      return [];
    }
  },
  readFile: async (path) => {
    try {
      return (await NodeFSP.readFile(path, "utf8")).trim();
    } catch {
      return null;
    }
  },
};

interface ChipFiles {
  readonly directory: string;
  readonly name: string;
  /** The chip directory's entries, in kernel order. */
  readonly entries: ReadonlyArray<string>;
}

interface FanFile {
  readonly chip: string;
  readonly label: string;
  readonly file: string;
}

/** The handful of files a refresh reads, chosen once per process. */
interface SensorSelection {
  readonly cpuTempFile: string | null;
  readonly diskTempFile: string | null;
  readonly fans: ReadonlyArray<FanFile>;
}

const textOrNull = (value: string | null): string | null =>
  value === null || value.length === 0 ? null : value;

const numberOrNull = (value: string | null): number | null => {
  if (value === null || value.length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sorted = (entries: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...entries].sort((left, right) =>
    left.localeCompare(right, "en", { numeric: true, sensitivity: "base" }),
  );

const labelIs = (label: string | null, wanted: string) =>
  label !== null && label.trim().toLowerCase() === wanted.toLowerCase();

const toCelsius = (milliC: number): number => Math.round(milliC / 1000);

async function readChips(root: string, io: HostSensorIo): Promise<ReadonlyArray<ChipFiles>> {
  const base = NodePath.join(root, "class", "hwmon");
  const chips: ChipFiles[] = [];
  for (const entry of sorted(await io.readdir(base))) {
    if (!entry.startsWith("hwmon")) continue;
    const directory = NodePath.join(base, entry);
    const name = textOrNull(await io.readFile(NodePath.join(directory, "name")));
    if (name === null) continue;
    chips.push({
      directory,
      name: name.toLowerCase(),
      entries: sorted(await io.readdir(directory)),
    });
  }
  return chips;
}

async function firstLabeledTempFile(
  chip: ChipFiles,
  label: string,
  io: HostSensorIo,
): Promise<string | null> {
  for (const entry of chip.entries) {
    const match = /^temp(\d+)_input$/.exec(entry);
    if (match === null) continue;
    const found = textOrNull(
      await io.readFile(NodePath.join(chip.directory, `temp${match[1]}_label`)),
    );
    if (labelIs(found, label)) return NodePath.join(chip.directory, entry);
  }
  return null;
}

function firstTempFile(chip: ChipFiles): string | null {
  const entry = chip.entries.find((candidate) => /^temp\d+_input$/.test(candidate));
  return entry === undefined ? null : NodePath.join(chip.directory, entry);
}

async function thermalZoneTempFile(root: string, io: HostSensorIo): Promise<string | null> {
  const base = NodePath.join(root, "class", "thermal");
  for (const entry of sorted(await io.readdir(base))) {
    if (!entry.startsWith("thermal_zone")) continue;
    const directory = NodePath.join(base, entry);
    if (textOrNull(await io.readFile(NodePath.join(directory, "type"))) === "x86_pkg_temp") {
      return NodePath.join(directory, "temp");
    }
  }
  return null;
}

async function cpuTempFile(
  root: string,
  chips: ReadonlyArray<ChipFiles>,
  io: HostSensorIo,
): Promise<string | null> {
  const coretemp = chips.find((chip) => chip.name === "coretemp");
  if (coretemp !== undefined) {
    const file = await firstLabeledTempFile(coretemp, "Package id 0", io);
    if (file !== null) return file;
  }

  const k10temp = chips.find((chip) => chip.name === "k10temp");
  if (k10temp !== undefined) {
    const file = await firstLabeledTempFile(k10temp, "Tctl", io);
    if (file !== null) return file;
  }

  const zone = await thermalZoneTempFile(root, io);
  if (zone !== null) return zone;

  const tcpu = chips.find((chip) => chip.name === "tcpu");
  return tcpu === undefined ? null : firstTempFile(tcpu);
}

async function diskTempFile(
  chips: ReadonlyArray<ChipFiles>,
  io: HostSensorIo,
): Promise<string | null> {
  const nvme = chips.find((chip) => chip.name === "nvme");
  if (nvme !== undefined) {
    const composite = await firstLabeledTempFile(nvme, "Composite", io);
    if (composite !== null) return composite;
  }

  const drivetemp = chips.find((chip) => chip.name === "drivetemp");
  return drivetemp === undefined ? null : firstTempFile(drivetemp);
}

async function fanFiles(
  chips: ReadonlyArray<ChipFiles>,
  io: HostSensorIo,
): Promise<ReadonlyArray<FanFile>> {
  const files: FanFile[] = [];
  for (const chip of chips) {
    for (const entry of chip.entries) {
      const match = /^fan(\d+)_input$/.exec(entry);
      if (match === null) continue;
      const label = textOrNull(
        await io.readFile(NodePath.join(chip.directory, `fan${match[1]}_label`)),
      );
      if (label === null) continue;
      files.push({
        chip: chip.directory,
        label: label.trim(),
        file: NodePath.join(chip.directory, entry),
      });
    }
  }
  return files;
}

async function resolveSelection(root: string, io: HostSensorIo): Promise<SensorSelection> {
  const chips = await readChips(root, io);
  return {
    cpuTempFile: await cpuTempFile(root, chips, io),
    diskTempFile: await diskTempFile(chips, io),
    fans: await fanFiles(chips, io),
  };
}

interface RawReading {
  readonly value: number | null;
  readonly missing: boolean;
}

async function readNumber(file: string, io: HostSensorIo): Promise<RawReading> {
  const raw = await io.readFile(file);
  return raw === null
    ? { value: null, missing: true }
    : { value: numberOrNull(raw), missing: false };
}

/**
 * Reads the chosen files. Null means a chosen file vanished, so the next
 * refresh resolves the tree again; the last value stays on screen.
 */
async function readSelection(
  selection: SensorSelection,
  io: HostSensorIo,
): Promise<HostSensors | null> {
  let missing = false;
  const read = async (file: string | null): Promise<number | null> => {
    if (file === null) return null;
    const reading = await readNumber(file, io);
    if (reading.missing) missing = true;
    return reading.value;
  };

  const cpuMilli = await read(selection.cpuTempFile);
  const diskMilli = await read(selection.diskTempFile);

  const collected: HostSensorFan[] = [];
  for (const fan of selection.fans) {
    const rpm = await read(fan.file);
    if (rpm === null || rpm <= 0) continue;
    if (collected.some((kept) => kept.rpm === rpm)) continue;
    collected.push({ label: fan.label, rpm });
    if (collected.length === 4) break;
  }

  if (missing) return null;
  return {
    cpuTempC: cpuMilli === null ? null : toCelsius(cpuMilli),
    diskTempC: diskMilli === null ? null : toCelsius(diskMilli),
    fans: collected,
  };
}

export interface HostSensorReader {
  /** The last reading; NO_HOST_SENSORS before the first refresh. */
  current(): HostSensors;
  /** Reads only when older than the TTL. */
  read(nowMs: number): Promise<HostSensors>;
  /** Starts a background refresh when stale. Never waits and never throws. */
  revalidate(nowMs: number): void;
}

export interface HostSensorReaderOptions {
  readonly root?: string;
  readonly io?: HostSensorIo;
  readonly staleAfterMs?: number;
}

export function makeHostSensorReader(options: HostSensorReaderOptions = {}): HostSensorReader {
  const root = options.root ?? "/sys";
  const io = options.io ?? nodeIo;
  const staleAfterMs = options.staleAfterMs ?? 5_000;
  let value = NO_HOST_SENSORS;
  let at: number | null = null;
  let selection: SensorSelection | null = null;
  let resolved = false;
  let inFlight: Promise<HostSensors> | null = null;

  const refresh = (nowMs: number): Promise<HostSensors> => {
    if (inFlight !== null) return inFlight;
    const run = (async () => {
      if (!resolved) {
        selection = await resolveSelection(root, io);
        resolved = true;
      }
      if (selection !== null) {
        const next = await readSelection(selection, io);
        if (next === null) {
          // The tree changed under us; resolve again on the next refresh.
          selection = null;
          resolved = false;
        } else {
          value = next;
        }
      }
      at = nowMs;
      return value;
    })()
      .catch(() => {
        at = nowMs;
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = run;
    return run;
  };

  return {
    current: () => value,
    read: async (nowMs) => {
      if (at !== null && nowMs - at < staleAfterMs) return value;
      return refresh(nowMs);
    },
    revalidate: (nowMs) => {
      if (inFlight !== null) return;
      if (at !== null && nowMs - at < staleAfterMs) return;
      void refresh(nowMs);
    },
  };
}

/** One reading from a `/sys` tree (or a fixture shaped like it). */
export async function readHostSensors(root = "/sys"): Promise<HostSensors> {
  return makeHostSensorReader({ root }).read(0);
}
