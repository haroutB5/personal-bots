// @effect-diagnostics nodeBuiltinImport:off - sysfs is plain files; the reads are tiny and local.
// @effect-diagnostics globalDate:off - the sampler passes its own clock; the default argument is a plain timestamp.
/**
 * The Linux sensor reader behind the Performance tab, the counterpart of the
 * Windows `SensorReaders` (which asks LibreHardwareMonitor and the Dell fan
 * exporter over loopback HTTP).
 *
 * Everything comes from `/sys` and `/proc`, so there is no helper app to
 * install and nothing to keep running:
 *
 * - temperatures and fans: `/sys/class/hwmon/*` (`coretemp` on this laptop's
 *   i7-12700H, `nvme` for the SSD, `dell_smm` for the fans);
 * - P/E core strips: `coretemp` leaves split by `/sys/devices/cpu_core` and
 *   `/sys/devices/cpu_atom`, the hybrid CPUs of each cluster;
 * - CPU package and platform power: Intel RAPL (`/sys/class/powercap`);
 * - GPU power: the card's own hwmon node, when the driver exposes one;
 * - battery: `/sys/class/power_supply/BAT*`.
 *
 * The reading is synchronous on purpose: a dozen small files every two seconds
 * costs less than the Windows HTTP fetches it replaces. A missing file makes
 * its field null, never an error on the screen - the same calm rule as Windows.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { FanSensors, LhmSensors, SensorsReading } from "./sensors.ts";

export interface LinuxSensorRoots {
  /** Default "/": the sysfs and procfs roots, overridable so tests use fixtures. */
  readonly sysRoot?: string;
  readonly procRoot?: string;
}

const MICRO = 1_000_000;

const readText = (file: string): string | null => {
  try {
    return NodeFS.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

const readNumber = (file: string): number | null => {
  const text = readText(file);
  if (text === null || text === "") return null;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
};

const readDirectory = (dir: string): ReadonlyArray<string> => {
  try {
    return NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

interface HwmonNode {
  readonly dir: string;
  readonly name: string;
}

/** Every hwmon device, keyed by the chip name the kernel gives it. */
function hwmonNodes(sysRoot: string): ReadonlyArray<HwmonNode> {
  const base = NodePath.join(sysRoot, "class", "hwmon");
  const out: HwmonNode[] = [];
  for (const entry of readDirectory(base)) {
    if (!entry.startsWith("hwmon")) continue;
    const dir = NodePath.join(base, entry);
    const name = readText(NodePath.join(dir, "name"));
    if (name !== null && name !== "") out.push({ dir, name });
  }
  return out;
}

interface TempLeaf {
  readonly label: string | null;
  readonly c: number;
}

function temperatureLeaves(node: HwmonNode): ReadonlyArray<TempLeaf> {
  const leaves: TempLeaf[] = [];
  for (const entry of readDirectory(node.dir)) {
    const match = /^temp(\d+)_input$/.exec(entry);
    if (match === null) continue;
    const raw = readNumber(NodePath.join(node.dir, entry));
    if (raw === null) continue;
    const label = readText(NodePath.join(node.dir, `temp${match[1]}_label`));
    leaves.push({ label: label === "" ? null : label, c: round1(raw / 1000) });
  }
  return leaves;
}

const CPU_CHIPS = new Set(["coretemp", "k10temp", "zenpower", "cpu_thermal", "soc_thermal"]);
const SSD_CHIPS = new Set(["nvme", "drivetemp", "nvme-pci"]);

/** `0-11,14` -> [0..11, 14]; the kernel's cpulist format. */
function parseCpuList(text: string | null): ReadonlyArray<number> {
  if (text === null) return [];
  const cpus: number[] = [];
  for (const part of text.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (match === null) continue;
    const first = Number.parseInt(match[1]!, 10);
    const last = match[2] === undefined ? first : Number.parseInt(match[2]!, 10);
    for (let cpu = first; cpu <= last && cpus.length < 4096; cpu++) cpus.push(cpu);
  }
  return cpus;
}

type CoreKind = "p" | "e";

/**
 * The order coretemp numbers its per-core leaves, as P/E classes.
 *
 * `cpu_core`/`cpu_atom` list the CPUs of each hybrid cluster. Walking CPUs in
 * ascending order and keeping the first of each (package, core) pair gives the
 * order the coretemp driver registers its "Core N" devices in (first thread of
 * each physical core, P cluster first on Alder Lake). Null - never a guess -
 * when the hybrid PMUs or topology files are absent (non-hybrid CPU, a VM), or
 * when the shapes do not line up.
 */
function hybridCoreOrder(sysRoot: string): ReadonlyArray<CoreKind> | null {
  const pCpus = parseCpuList(readText(NodePath.join(sysRoot, "devices", "cpu_core", "cpus")));
  const eCpus = parseCpuList(readText(NodePath.join(sysRoot, "devices", "cpu_atom", "cpus")));
  if (pCpus.length === 0 || eCpus.length === 0) return null;
  const pSet = new Set(pCpus);
  const seen = new Set<string>();
  const kinds: CoreKind[] = [];
  const all = [...new Set([...pCpus, ...eCpus])].sort((a, b) => a - b);
  for (const cpu of all) {
    const topology = NodePath.join(sysRoot, "devices", "system", "cpu", `cpu${cpu}`, "topology");
    const coreId = readText(NodePath.join(topology, "core_id"));
    if (coreId === null) return null;
    const packageId = readText(NodePath.join(topology, "physical_package_id")) ?? "0";
    const key = `${packageId}:${coreId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kinds.push(pSet.has(cpu) ? "p" : "e");
  }
  if (!kinds.includes("p") || !kinds.includes("e")) return null;
  return kinds;
}

interface CoreStrips {
  readonly pCoreC: ReadonlyArray<number> | null;
  readonly eCoreC: ReadonlyArray<number> | null;
}

const NO_CORE_STRIPS: CoreStrips = { pCoreC: null, eCoreC: null };

/**
 * Per-core temperatures split into P and E strips, the arrays Windows gets from
 * LibreHardwareMonitor. The split is only returned on an exact match: every
 * coretemp leaf is "Core N", the labels are exactly 0..n-1, and n equals the
 * number of physical cores the hybrid PMUs report. A kernel that labels cores
 * differently yields null instead of a mislabelled strip.
 */
function coreStrips(
  nodes: ReadonlyArray<HwmonNode>,
  order: ReadonlyArray<CoreKind> | null,
): CoreStrips {
  if (order === null || order.length === 0) return NO_CORE_STRIPS;
  for (const node of nodes) {
    if (!CPU_CHIPS.has(node.name)) continue;
    const leaves: { readonly index: number; readonly c: number }[] = [];
    for (const leaf of temperatureLeaves(node)) {
      const match = /^Core\s+(\d+)$/i.exec(leaf.label ?? "");
      if (match === null) continue;
      leaves.push({ index: Number.parseInt(match[1]!, 10), c: leaf.c });
    }
    if (leaves.length !== order.length) return NO_CORE_STRIPS;
    leaves.sort((a, b) => a.index - b.index);
    for (const [position, leaf] of leaves.entries()) {
      if (leaf.index !== position) return NO_CORE_STRIPS;
    }
    const p: number[] = [];
    const e: number[] = [];
    for (const [position, leaf] of leaves.entries()) {
      if (order[position] === "p") p.push(leaf.c);
      else e.push(leaf.c);
    }
    return p.length > 0 && e.length > 0 ? { pCoreC: p, eCoreC: e } : NO_CORE_STRIPS;
  }
  return NO_CORE_STRIPS;
}

/** The package sensor, else the hottest CPU leaf: both are honest readings. */
function cpuTemperature(
  nodes: ReadonlyArray<HwmonNode>,
): { readonly packageC: number | null; readonly hottestC: number | null } {
  for (const node of nodes) {
    if (!CPU_CHIPS.has(node.name)) continue;
    const leaves = temperatureLeaves(node);
    if (leaves.length === 0) continue;
    const pkg = leaves.find((leaf) => /package/i.test(leaf.label ?? ""));
    const hottest = leaves.reduce<TempLeaf | null>(
      (best, leaf) => (best === null || leaf.c > best.c ? leaf : best),
      null,
    );
    return { packageC: pkg?.c ?? hottest?.c ?? null, hottestC: hottest?.c ?? null };
  }
  return { packageC: null, hottestC: null };
}

function ssdTemperature(nodes: ReadonlyArray<HwmonNode>): number | null {
  for (const node of nodes) {
    if (!SSD_CHIPS.has(node.name)) continue;
    const leaves = temperatureLeaves(node);
    const composite = leaves.find((leaf) => /composite/i.test(leaf.label ?? ""));
    if (composite !== undefined) return composite.c;
    // No labels at all (some NVMe drivers): the first leaf is the composite.
    if (leaves.length > 0 && leaves.every((leaf) => leaf.label === null)) return leaves[0]!.c;
  }
  return null;
}

function memoryTemperature(nodes: ReadonlyArray<HwmonNode>): number | null {
  for (const node of nodes) {
    if (!/^(spd5118|jc42|dimm|spd)$/i.test(node.name)) continue;
    const first = temperatureLeaves(node)[0];
    if (first !== undefined) return first.c;
  }
  return null;
}

function gpuPowerW(nodes: ReadonlyArray<HwmonNode>): number | null {
  for (const node of nodes) {
    if (!/^(amdgpu|nouveau|i915|xe)$/.test(node.name)) continue;
    for (const entry of readDirectory(node.dir)) {
      if (!/^power\d+_average$/.test(entry)) continue;
      const raw = readNumber(NodePath.join(node.dir, entry));
      if (raw !== null && raw > 0) return round1(raw / MICRO);
    }
  }
  return null;
}

/**
 * Fans in the order the kernel reports them: `dell_smm` exposes fan1 and fan2
 * on this laptop, `coretemp` exposes none.
 */
function fans(nodes: ReadonlyArray<HwmonNode>): FanSensors {
  for (const node of nodes) {
    const rpms: number[] = [];
    for (let index = 1; index <= 4; index++) {
      const rpm = readNumber(NodePath.join(node.dir, `fan${index}_input`));
      if (rpm !== null && rpm >= 0) rpms.push(Math.round(rpm));
    }
    if (rpms.length === 0) continue;
    return {
      status: rpms.length >= 2 ? "ok" : "partial",
      fan1Rpm: rpms[0] ?? null,
      fan2Rpm: rpms[1] ?? null,
    };
  }
  return { status: "unavailable", fan1Rpm: null, fan2Rpm: null };
}

interface RaplDomain {
  readonly name: string;
  readonly dir: string;
  readonly maxMicroJoules: number;
}

function raplDomains(sysRoot: string): ReadonlyArray<RaplDomain> {
  const out: RaplDomain[] = [];
  for (const root of ["intel-rapl", "amd-rapl"]) {
    const base = NodePath.join(sysRoot, "class", "powercap", root);
    for (const entry of readDirectory(base)) {
      if (!/^(intel|amd)-rapl:\d+$/.test(entry)) continue;
      const dir = NodePath.join(base, entry);
      out.push({
        name: readText(NodePath.join(dir, "name")) ?? entry,
        dir,
        maxMicroJoules: readNumber(NodePath.join(dir, "max_energy_range_uj")) ?? 0,
      });
    }
  }
  return out;
}

export interface LinuxBattery {
  readonly rateW: number | null;
  readonly designWh: number | null;
  readonly fullWh: number | null;
  readonly pct: number | null;
  readonly state: "charging" | "discharging" | "full" | "plugged" | "unknown";
  readonly minutesLeft: number | null;
}

/** The first battery the kernel reports, or all-null when the machine has none. */
export function readLinuxBattery(sysRoot: string): LinuxBattery {
  const base = NodePath.join(sysRoot, "class", "power_supply");
  const battery = readDirectory(base).find((entry) => /^BAT\d$/.test(entry));
  if (battery === undefined) {
    return {
      rateW: null,
      designWh: null,
      fullWh: null,
      pct: null,
      state: "unknown",
      minutesLeft: null,
    };
  }
  const dir = NodePath.join(base, battery);
  const micro = (name: string): number | null => readNumber(NodePath.join(dir, name));
  const nowW = micro("power_now");
  const currentUa = micro("current_now");
  const voltageUv = micro("voltage_now");
  const rateW =
    nowW !== null
      ? round1(Math.abs(nowW) / MICRO)
      : currentUa !== null && voltageUv !== null
        ? round1(Math.abs((currentUa / MICRO) * (voltageUv / MICRO)))
        : null;
  const energyFull = micro("energy_full");
  const energyDesign = micro("energy_full_design");
  const chargeFull = micro("charge_full");
  const chargeDesign = micro("charge_full_design");
  const designWh =
    energyDesign !== null
      ? round1(energyDesign / MICRO)
      : chargeDesign !== null && voltageUv !== null
        ? round1((chargeDesign / MICRO) * (voltageUv / MICRO))
        : null;
  const fullWh =
    energyFull !== null
      ? round1(energyFull / MICRO)
      : chargeFull !== null && voltageUv !== null
        ? round1((chargeFull / MICRO) * (voltageUv / MICRO))
        : null;
  const status = (readText(NodePath.join(dir, "status")) ?? "").toLowerCase();
  const state: LinuxBattery["state"] =
    status === "charging"
      ? "charging"
      : status === "discharging"
        ? "discharging"
        : status === "full"
          ? "full"
          : status === "not charging"
            ? "plugged"
            : "unknown";
  const pctRaw = micro("capacity");
  const energyNow = micro("energy_now");
  const minutesFile = micro("time_to_empty_now");
  // `time_to_empty_now` is minutes, but not every driver writes it; the
  // energy-now over power-now estimate covers the rest.
  const minutesLeft =
    minutesFile !== null && minutesFile > 0
      ? Math.round(minutesFile)
      : state === "discharging" && energyNow !== null && nowW !== null && nowW > 0
        ? Math.round(((energyNow / MICRO) * 60) / (nowW / MICRO))
        : null;
  return {
    rateW,
    designWh,
    fullWh,
    pct: pctRaw !== null ? Math.round(pctRaw) : null,
    state,
    minutesLeft,
  };
}

const EMPTY_SENSORS: LhmSensors = {
  cpuTempC: null,
  pCoreC: null,
  eCoreC: null,
  ssdC: null,
  ssdWarnC: null,
  ssdCritC: null,
  ramC: null,
  powerCpuW: null,
  powerGpuW: null,
  powerPlatformW: null,
  batteryRateW: null,
  batteryDesignWh: null,
  batteryFullWh: null,
};

/**
 * The sampler's sensor side on Linux. No network, no spawn: it reads sysfs,
 * and keeps the previous RAPL energy so a power reading is a rate over the
 * tick, not a lifetime total.
 */
export class LinuxSensorReader {
  private readonly sysRoot: string;
  private previousEnergy = new Map<string, { readonly microJoules: number; readonly atMs: number }>();
  /** The hybrid core order never changes; read once, then reused every tick. */
  private coreOrder: ReadonlyArray<CoreKind> | null | undefined = undefined;

  constructor(roots: LinuxSensorRoots = {}) {
    this.sysRoot = roots.sysRoot ?? "/";
  }

  private coreOrderOnce(): ReadonlyArray<CoreKind> | null {
    if (this.coreOrder === undefined) this.coreOrder = hybridCoreOrder(this.sysRoot);
    return this.coreOrder;
  }

  /** Watts since the previous read, from a wrapping microjoule counter. */
  private powerW(domain: RaplDomain, nowMs: number): number | null {
    const raw = readNumber(NodePath.join(domain.dir, "energy_uj"));
    if (raw === null) return null;
    const previous = this.previousEnergy.get(domain.dir);
    this.previousEnergy.set(domain.dir, { microJoules: raw, atMs: nowMs });
    if (previous === undefined) return null;
    const elapsedMs = nowMs - previous.atMs;
    if (elapsedMs <= 0) return null;
    let delta = raw - previous.microJoules;
    if (delta < 0 && domain.maxMicroJoules > 0) delta += domain.maxMicroJoules;
    if (delta < 0) return null;
    return round1(delta / MICRO / (elapsedMs / 1000));
  }

  read(nowMs = Date.now()): SensorsReading {
    const nodes = hwmonNodes(this.sysRoot);
    const cpu = cpuTemperature(nodes);
    const strips = coreStrips(nodes, this.coreOrderOnce());
    const battery = readLinuxBattery(this.sysRoot);
    const domains = raplDomains(this.sysRoot);
    let powerCpuW: number | null = null;
    let powerPlatformW: number | null = null;
    for (const domain of domains) {
      const name = domain.name.toLowerCase();
      if (/^(package|psys|cpu)/.test(name) && !name.includes(":")) {
        const watts = this.powerW(domain, nowMs);
        if (name.includes("psys")) powerPlatformW = watts;
        else if (powerCpuW === null) powerCpuW = watts;
      }
    }
    const sensors: LhmSensors = {
      ...EMPTY_SENSORS,
      cpuTempC: cpu.packageC,
      pCoreC: strips.pCoreC,
      eCoreC: strips.eCoreC,
      ssdC: ssdTemperature(nodes),
      ramC: memoryTemperature(nodes),
      powerCpuW,
      powerPlatformW: powerPlatformW ?? powerCpuW,
      powerGpuW: gpuPowerW(nodes),
      batteryRateW: battery.rateW,
      batteryDesignWh: battery.designWh,
      batteryFullWh: battery.fullWh,
    };
    const fan = fans(nodes);
    return {
      // The built-in reader is always there; "ok" means the sysfs tree answered.
      lhm: cpu.hottestC === null && sensors.ssdC === null ? "down" : "ok",
      sensors,
      fans: fan.status === "down" ? "down" : "ok",
      fan,
    };
  }
}

/** For the sampler's slow block: battery state from the same sysfs tree. */
export function readLinuxBatteryStatus(sysRoot = "/"): LinuxBattery {
  return readLinuxBattery(sysRoot);
}
