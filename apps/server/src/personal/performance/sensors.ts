// @effect-diagnostics globalFetch:off
/**
 * The two local sensor readers behind the Performance tab: LibreHardwareMonitor
 * (`127.0.0.1:8085/data.json`, the sensor tree) and the Dell fan exporter
 * (`127.0.0.1:8086/fan.json`). Both are read-only, loopback-only, and calm
 * when down: a sensor that does not answer makes its fields null, never an
 * error on the screen.
 *
 * Rules from SPEC-performance.md section 8 (Harout: no lag): at most one
 * fetch per reader per tick, 1 s timeout each, and a reader never overlaps
 * itself - while a fetch is in flight the previous answer keeps being used.
 */
import type { PerformanceFanStatus } from "@t3tools/contracts";

export interface LhmSensors {
  readonly cpuTempC: number | null;
  readonly pCoreC: ReadonlyArray<number> | null;
  readonly eCoreC: ReadonlyArray<number> | null;
  readonly ssdC: number | null;
  readonly ssdWarnC: number | null;
  readonly ssdCritC: number | null;
  readonly ramC: number | null;
  readonly powerCpuW: number | null;
  readonly powerGpuW: number | null;
  readonly powerPlatformW: number | null;
  readonly batteryRateW: number | null;
  readonly batteryDesignWh: number | null;
  readonly batteryFullWh: number | null;
}

export interface FanSensors {
  readonly status: PerformanceFanStatus;
  readonly fan1Rpm: number | null;
  readonly fan2Rpm: number | null;
}

export interface SensorsReading {
  readonly lhm: "ok" | "down";
  readonly sensors: LhmSensors;
  readonly fans: "ok" | "down";
  readonly fan: FanSensors;
}

/** The first number in "58653 mWh", "41.0 °C" or "5.5 W". */
export function firstNumber(text: string): number | null {
  const match = /-?\d+(?:\.\d+)?/.exec(text);
  if (match === null) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

interface LhmNode {
  readonly Text?: unknown;
  readonly Value?: unknown;
  readonly Children?: unknown;
}

/**
 * The sensor leaves of the LibreHardwareMonitor tree, keyed
 * `section::leaf` ("Temperatures::CPU Package"). Only the paths the tab reads
 * are kept; the tree has hundreds of nodes and none of the rest is wanted.
 * First occurrence wins: the CPU device sits near the top on this laptop.
 */
export function lhmLeaves(root: unknown): Map<string, string> {
  const leaves = new Map<string, string>();
  const visit = (node: LhmNode, section: string): void => {
    const text = typeof node.Text === "string" ? node.Text : "";
    const value = typeof node.Value === "string" ? node.Value : "";
    const children = Array.isArray(node.Children) ? (node.Children as LhmNode[]) : [];
    if (value !== "" && value !== "-") {
      const key = `${section}::${text}`;
      if (!leaves.has(key)) leaves.set(key, value);
    }
    if (children.length === 0) return;
    // The direct children of a section-like node share that node's name until
    // a deeper section appears; "Temperatures" and "Powers" are sections.
    const nextSection = /^Temperatures$|^Powers$|^Capacities$|^Levels$/.test(text) ? text : section;
    for (const child of children) visit(child, nextSection);
  };
  const top = root as LhmNode | null;
  if (top === null || typeof top !== "object") return leaves;
  for (const child of Array.isArray(top.Children) ? (top.Children as LhmNode[]) : []) {
    const named = typeof child.Text === "string" ? child.Text : "";
    visit(child, named);
  }
  return leaves;
}

/** The sensor fields the tab reads, pulled out of the leaf map. */
export function parseLhmSensors(root: unknown): LhmSensors {
  const leaves = lhmLeaves(root);
  const get = (key: string): number | null => {
    const raw = leaves.get(key);
    return raw === undefined ? null : firstNumber(raw);
  };
  const series = (prefix: string, count: number): ReadonlyArray<number> | null => {
    const out: number[] = [];
    for (let i = 1; i <= count; i++) {
      const value = get(`Temperatures::${prefix} #${i}`);
      if (value === null) return null;
      out.push(value);
    }
    return out;
  };
  const full = get("Capacities::Fully-Charged Capacity");
  const design = get("Capacities::Designed Capacity");
  return {
    cpuTempC: get("Temperatures::CPU Package"),
    pCoreC: series("P-Core", 6),
    eCoreC: series("E-Core", 8),
    ssdC: get("Temperatures::Composite Temperature"),
    ssdWarnC: get("Temperatures::Warning Temperature"),
    ssdCritC: get("Temperatures::Critical Temperature"),
    ramC: get("Temperatures::DIMM #0"),
    powerCpuW: get("Powers::CPU Package"),
    powerGpuW: get("Powers::GPU Power"),
    powerPlatformW: get("Powers::CPU Platform"),
    batteryRateW: get("Powers::Charge/Discharge Rate"),
    batteryDesignWh: design === null ? null : Math.round(design / 100) / 10,
    batteryFullWh: full === null ? null : Math.round(full / 100) / 10,
  };
}

/** The fan exporter's answer, or a calm "down". */
export function parseFanJson(data: unknown): FanSensors {
  const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  const status = obj?.["status"];
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
  if (status === "ok") {
    return {
      status: "ok",
      fan1Rpm: num(obj?.["fan1Rpm"]),
      fan2Rpm: num(obj?.["fan2Rpm"]),
    };
  }
  if (status === "partial") {
    return {
      status: "partial",
      fan1Rpm: num(obj?.["fan1Rpm"]),
      fan2Rpm: num(obj?.["fan2Rpm"]),
    };
  }
  if (status === "unavailable") return { status: "unavailable", fan1Rpm: null, fan2Rpm: null };
  return { status: "down", fan1Rpm: null, fan2Rpm: null };
}

export const LHM_SENSOR_URL = "http://127.0.0.1:8085/data.json";
export const FAN_SENSOR_URL = "http://127.0.0.1:8086/fan.json";
export const SENSOR_TIMEOUT_MS = 1_000;

/**
 * Where the two readers look. Always loopback unless a test points them at a
 * stub or a closed port (`T3CODE_PERF_LHM_URL`, `T3CODE_PERF_FAN_URL`) - the
 * calm "sensors app not running" states are proven that way without touching
 * the laptop's real sensor apps.
 */
export function sensorUrls(env: NodeJS.ProcessEnv = process.env): {
  readonly lhm: string;
  readonly fan: string;
} {
  const lhm = env.T3CODE_PERF_LHM_URL?.trim();
  const fan = env.T3CODE_PERF_FAN_URL?.trim();
  return {
    lhm: lhm === undefined || lhm === "" ? LHM_SENSOR_URL : lhm,
    fan: fan === undefined || fan === "" ? FAN_SENSOR_URL : fan,
  };
}

const NO_SENSORS: LhmSensors = {
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

const FAN_DOWN: FanSensors = { status: "down", fan1Rpm: null, fan2Rpm: null };

export const SENSORS_DOWN: SensorsReading = {
  lhm: "down",
  sensors: NO_SENSORS,
  fans: "down",
  fan: FAN_DOWN,
};

export interface SensorReaderDeps {
  readonly fetchJson?: (url: string, timeoutMs: number) => Promise<unknown | null>;
  /** Where to look; defaults to `sensorUrls()` (loopback, env-overridable). */
  readonly urls?: { readonly lhm: string; readonly fan: string };
}

const defaultFetchJson = async (url: string, timeoutMs: number): Promise<unknown | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
};

/**
 * The sampler's sensor side. `read()` never waits on the network: it returns
 * the latest answer and, when that reader is idle, starts the next fetch in
 * the background. A reader that is still fetching is left alone, so requests
 * never overlap however slow LHM gets.
 */
export class SensorReaders {
  private readonly fetchJson: (url: string, timeoutMs: number) => Promise<unknown | null>;
  private readonly urls: { readonly lhm: string; readonly fan: string };
  private lhmInFlight = false;
  private fanInFlight = false;
  private latest: SensorsReading = SENSORS_DOWN;

  constructor(deps: SensorReaderDeps = {}) {
    this.fetchJson = deps.fetchJson ?? defaultFetchJson;
    this.urls = deps.urls ?? sensorUrls();
  }

  read(): SensorsReading {
    if (!this.lhmInFlight) {
      this.lhmInFlight = true;
      void this.fetchJson(this.urls.lhm, SENSOR_TIMEOUT_MS)
        .then((data) => {
          // A failed answer clears the values: showing last minute's
          // temperature as if it were now is worse than the calm note.
          this.latest =
            data === null
              ? { ...this.latest, lhm: "down", sensors: NO_SENSORS }
              : { ...this.latest, lhm: "ok", sensors: parseLhmSensors(data) };
        })
        .finally(() => {
          this.lhmInFlight = false;
        });
    }
    if (!this.fanInFlight) {
      this.fanInFlight = true;
      void this.fetchJson(this.urls.fan, SENSOR_TIMEOUT_MS)
        .then((data) => {
          const fan = data === null ? FAN_DOWN : parseFanJson(data);
          this.latest = { ...this.latest, fans: fan.status === "down" ? "down" : "ok", fan };
        })
        .finally(() => {
          this.fanInFlight = false;
        });
    }
    return this.latest;
  }

  /** For lifecycle proofs: nothing of this reader is running right now. */
  idle(): boolean {
    return !this.lhmInFlight && !this.fanInFlight;
  }
}
