/**
 * Parses what the counter helper prints (see `perfHelperScript.ts`) into the
 * small shapes the sampler copies into a sample. Pure functions, so the tests
 * feed them recorded helper lines.
 */

export interface HelperHello {
  readonly memTotalMB: number;
  readonly pcBootAt: number | null;
  readonly model: string | null;
  readonly cpuName: string | null;
  readonly physCores: number | null;
  readonly logicalProcessors: number | null;
  readonly maxClockMHz: number | null;
  readonly gpuName: string | null;
}

export interface HelperChild {
  readonly pid: number;
  readonly name: string;
  /** Kernel + user time, 100 ns ticks (for attributing only; PDH gives rates). */
  readonly cpu100ns: number;
  readonly wsBytes: number;
  readonly cmd: string;
}

/** [pid, parentPid, sessionId] for every process. */
export type HelperParentRow = readonly [number, number, number];

export interface HelperProcessRow {
  readonly name: string;
  /** Percent of ONE core (PDH Process % Processor Time; a pegged thread reads 100). */
  readonly cpuOneCore: number;
  /** Working Set - Private, bytes. */
  readonly memBytes: number;
  readonly pid: number;
}

export interface HelperSlow {
  readonly batteryPct: number | null;
  readonly batteryState: "charging" | "discharging" | "full" | "plugged" | "unknown";
  readonly batteryMinutesLeft: number | null;
  readonly diskTotalGB: number | null;
  readonly diskFreeGB: number | null;
}

export interface HelperTick {
  readonly t: number;
  readonly ms: number;
  readonly cpuUtility: number | null;
  readonly cpuPerformance: number | null;
  readonly memAvailableMB: number | null;
  readonly diskIdlePct: number | null;
  readonly diskReadBps: number | null;
  readonly diskWriteBps: number | null;
  readonly threads: ReadonlyArray<readonly [string, number | null]>;
  readonly gpu: ReadonlyArray<readonly [string, number | null]>;
  readonly netRx: ReadonlyArray<readonly [string, number | null]>;
  readonly netTx: ReadonlyArray<readonly [string, number | null]>;
  readonly processes: ReadonlyArray<HelperProcessRow>;
  readonly children: ReadonlyArray<HelperChild>;
  readonly parents: ReadonlyArray<HelperParentRow> | null;
  /** Battery and the C: drive; present only on the helper's slow ticks. */
  readonly slow: HelperSlow | null;
}

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asPairs = (value: unknown): ReadonlyArray<readonly [string, number | null]> => {
  if (!Array.isArray(value)) return [];
  const out: Array<readonly [string, number | null]> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    out.push([entry[0], asNumber(entry[1])]);
  }
  return out;
};

/** One hello line, or null when the text is not one. */
export function parseHelperHello(line: string): HelperHello | null {
  let parsed: Json | null;
  try {
    parsed = asObject(JSON.parse(line));
  } catch {
    return null;
  }
  if (parsed === null || parsed["kind"] !== "hello") return null;
  return {
    memTotalMB: asNumber(parsed["memTotalMB"]) ?? 0,
    pcBootAt: asNumber(parsed["pcBootAt"]),
    model: asString(parsed["model"]),
    cpuName: asString(parsed["cpuName"]),
    physCores: asNumber(parsed["physCores"]),
    logicalProcessors: asNumber(parsed["logicalProcessors"]),
    maxClockMHz: asNumber(parsed["maxClockMHz"]),
    gpuName: asString(parsed["gpuName"]),
  };
}

/**
 * One tick line, or null when the text is not one. A malformed line is
 * dropped, never guessed at: a tick with wrong numbers is worse than a gap.
 */
export function parseHelperTick(line: string): HelperTick | null {
  let parsed: Json | null;
  try {
    parsed = asObject(JSON.parse(line));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed["t"] !== "number") return null;
  const counters = asObject(parsed["c"]);
  if (counters === null) return null;

  const processes: HelperProcessRow[] = [];
  const rawProc = counters["proc"];
  if (Array.isArray(rawProc)) {
    for (const row of rawProc) {
      if (!Array.isArray(row) || typeof row[0] !== "string") continue;
      const cpu = asNumber(row[1]);
      const mem = asNumber(row[2]);
      const pid = asNumber(row[3]);
      if (pid === null) continue;
      processes.push({
        name: row[0],
        cpuOneCore: cpu ?? 0,
        memBytes: mem ?? 0,
        pid,
      });
    }
  }

  const children: HelperChild[] = [];
  const rawKids = parsed["k"];
  if (Array.isArray(rawKids)) {
    for (const row of rawKids) {
      const obj = asObject(row);
      if (obj === null) continue;
      const pid = asNumber(obj["pid"]);
      if (pid === null) continue;
      children.push({
        pid,
        name: asString(obj["name"]) ?? "",
        cpu100ns: asNumber(obj["cpu100ns"]) ?? 0,
        wsBytes: asNumber(obj["wsBytes"]) ?? 0,
        cmd: asString(obj["cmd"]) ?? "",
      });
    }
  }

  let parents: HelperParentRow[] | null = null;
  const rawParents = parsed["pp"];
  if (Array.isArray(rawParents)) {
    parents = [];
    for (const row of rawParents) {
      if (!Array.isArray(row)) continue;
      const pid = asNumber(row[0]);
      const parent = asNumber(row[1]);
      const session = asNumber(row[2]);
      if (pid === null || parent === null) continue;
      parents.push([pid, parent, session ?? 0]);
    }
  }

  const slowObj = asObject(parsed["s"]);
  const states = ["charging", "discharging", "full", "plugged", "unknown"] as const;
  const rawState = slowObj === null ? null : asString(slowObj["batteryState"]);
  const slow: HelperSlow | null =
    slowObj === null
      ? null
      : {
          batteryPct: asNumber(slowObj["batteryPct"]),
          batteryState:
            rawState !== null && (states as ReadonlyArray<string>).includes(rawState)
              ? (rawState as HelperSlow["batteryState"])
              : "unknown",
          batteryMinutesLeft: asNumber(slowObj["batteryMinutesLeft"]),
          diskTotalGB: asNumber(slowObj["diskTotalGB"]),
          diskFreeGB: asNumber(slowObj["diskFreeGB"]),
        };

  return {
    t: parsed["t"],
    ms: asNumber(parsed["ms"]) ?? 0,
    cpuUtility: asNumber(counters["cpuUtility"]),
    cpuPerformance: asNumber(counters["cpuPerformance"]),
    memAvailableMB: asNumber(counters["memAvailableMB"]),
    diskIdlePct: asNumber(counters["diskIdlePct"]),
    diskReadBps: asNumber(counters["diskReadBps"]),
    diskWriteBps: asNumber(counters["diskWriteBps"]),
    threads: asPairs(counters["threads"]),
    gpu: asPairs(counters["gpu"]),
    netRx: asPairs(counters["netRx"]),
    netTx: asPairs(counters["netTx"]),
    processes,
    children,
    parents,
    slow,
  };
}

/**
 * The per-thread load in logical processor order, `_Total` dropped. Null
 * until every thread of the machine has a value: a half strip is a lie.
 */
export function threadPct(
  threads: ReadonlyArray<readonly [string, number | null]>,
  count: number,
): ReadonlyArray<number> | null {
  const byIndex = new Map<number, number>();
  for (const [name, value] of threads) {
    if (value === null) continue;
    const match = /^0,(\d+)$/.exec(name);
    if (match === null) continue; // "0,_Total" and anything else
    byIndex.set(Number(match[1]), Math.round(value * 10) / 10);
  }
  if (byIndex.size < count) return null;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = byIndex.get(i);
    if (value === undefined) return null;
    out.push(value);
  }
  return out;
}

/**
 * The busiest GPU engine type and its summed utilisation: the maximum, per
 * engine type, of the sum over every engine instance of that type (the 3D
 * engine alone rarely reaches 100 on shared memory).
 */
export function gpuBusy(
  gpu: ReadonlyArray<readonly [string, number | null]>,
): { readonly pct: number; readonly engine: string } | null {
  const byType = new Map<string, number>();
  for (const [instance, value] of gpu) {
    if (value === null || value <= 0) continue;
    // "pid_10188_luid_0x0_phys_0_eng_0_engtype_3D" (or ..._engtype_VideoDecode)
    const marker = instance.indexOf("engtype_");
    if (marker < 0) continue;
    const type = instance.slice(marker + "engtype_".length);
    if (type === "") continue;
    byType.set(type, (byType.get(type) ?? 0) + value);
  }
  let best: { pct: number; engine: string } | null = null;
  for (const [engine, total] of byType) {
    if (best === null || total > best.pct) best = { pct: total, engine };
  }
  return best;
}

/** The adapter carrying the most traffic this tick, with both rates. */
export function busiestAdapter(
  rx: ReadonlyArray<readonly [string, number | null]>,
  tx: ReadonlyArray<readonly [string, number | null]>,
): { readonly name: string; readonly downBps: number; readonly upBps: number } | null {
  const up = new Map<string, number>();
  for (const [name, value] of tx) if (value !== null) up.set(name, value);
  let best: { name: string; downBps: number; upBps: number } | null = null;
  for (const [name, value] of rx) {
    if (value === null) continue;
    const upBps = up.get(name) ?? 0;
    if (best === null || value + upBps > best.downBps + best.upBps) {
      best = { name, downBps: value, upBps };
    }
  }
  return best;
}

/** The system clock from `% Processor Performance` against the nominal clock. */
export function clockGHz(performance: number | null, maxClockMHz: number | null): number | null {
  if (performance === null) return null;
  const nominalGHz = maxClockMHz === null ? 2.3 : maxClockMHz / 1000;
  return Math.round(nominalGHz * (performance / 100) * 10) / 10;
}
