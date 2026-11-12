// @effect-diagnostics globalTimers:off -- The abort timer wraps a plain fetch so
// web and phone callers keep a Promise API. React Native's AbortSignal polyfill
// has no static timeout.
/**
 * The PC's CPU, RAM and disk for the line under the Bots page header
 * (SystemStatsLine.tsx). The numbers come from
 * `GET /api/personal/performance/summary` (server
 */

export const SYSTEM_SUMMARY_URL = "/api/personal/performance/summary";
export const SYSTEM_SUMMARY_TIMEOUT_MS = 5_000;

/** A figure at or above this is inked amber. */
export const BUSY_PERCENT = 90;
/** Free disk below this share of the drive is inked amber. */
export const LOW_DISK_SHARE = 0.1;

export interface SystemSummary {
  readonly cpuPct: number | null;
  readonly memUsedPct: number | null;
  readonly memUsedGB: number | null;
  readonly memTotalGB: number | null;
  readonly diskLabel: string | null;
  readonly diskFreeGB: number | null;
  readonly diskTotalGB: number | null;
  /** Package temperature, C. Null when the host has no readable sensor. */
  readonly cpuTempC: number | null;
  /** The data drive's temperature, C. Null when it has none. */
  readonly diskTempC: number | null;
  /** Labelled case and CPU fans, empty when the host reports none. */
  readonly fans: ReadonlyArray<SystemFan>;
}

export interface SystemFan {
  readonly label: string;
  readonly rpm: number;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A drive name like "C:" reads well; a mount path like "/" or "/home" does not, so it becomes "Disk". */
function diskLabelOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (label.length === 0 || label.length > 16 || /[\\/]/.test(label)) return null;
  return label;
}

/** Fans from a new server; an old one sends nothing, a bad entry is skipped. */
function fansOrEmpty(value: unknown): ReadonlyArray<SystemFan> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === "string" ? record.label.trim() : "";
    const rpm = numberOrNull(record.rpm);
    return label.length === 0 || rpm === null || rpm <= 0 ? [] : [{ label, rpm }];
  });
}

export function parseSystemSummary(raw: unknown): SystemSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  return {
    cpuPct: numberOrNull(record.cpuPct),
    memUsedPct: numberOrNull(record.memUsedPct),
    memUsedGB: numberOrNull(record.memUsedGB),
    memTotalGB: numberOrNull(record.memTotalGB),
    diskLabel: diskLabelOrNull(record.diskLabel),
    diskFreeGB: numberOrNull(record.diskFreeGB),
    diskTotalGB: numberOrNull(record.diskTotalGB),
    cpuTempC: numberOrNull(record.cpuTempC),
    diskTempC: numberOrNull(record.diskTempC),
    fans: fansOrEmpty(record.fans),
  };
}

export async function fetchSystemSummary(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SYSTEM_SUMMARY_TIMEOUT_MS,
): Promise<SystemSummary | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(SYSTEM_SUMMARY_URL, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseSystemSummary(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SystemStatPart {
  readonly key: "cpu" | "ram" | "disk";
  readonly text: string;
  readonly busy: boolean;
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

/** "120 GB", "1.2 TB", "8.5 GB": whole GB from 10 up, one decimal below. */
export function formatGB(value: number): string {
  if (value >= 1000) return `${(value / 1024).toFixed(1)} TB`;
  return value >= 10 ? `${Math.round(value)} GB` : `${value.toFixed(1)} GB`;
}

/** "CPU 12%", "RAM 63%", "C: 120 GB free"; a figure the server did not have is left out. */
export function systemStatParts(summary: SystemSummary): ReadonlyArray<SystemStatPart> {
  const parts: SystemStatPart[] = [];
  if (summary.cpuPct !== null) {
    const pct = clampPercent(summary.cpuPct);
    parts.push({ key: "cpu", text: `CPU ${pct}%`, busy: pct >= BUSY_PERCENT });
  }
  if (summary.memUsedPct !== null) {
    const pct = clampPercent(summary.memUsedPct);
    parts.push({ key: "ram", text: `RAM ${pct}%`, busy: pct >= BUSY_PERCENT });
  }
  if (summary.diskFreeGB !== null) {
    const label = summary.diskLabel ?? "Disk";
    const low =
      summary.diskTotalGB !== null &&
      summary.diskTotalGB > 0 &&
      summary.diskFreeGB / summary.diskTotalGB < LOW_DISK_SHARE;
    parts.push({ key: "disk", text: `${label} ${formatGB(summary.diskFreeGB)} free`, busy: low });
  }
  return parts;
}

/** The whole line in words, for screen readers. */
export function systemStatsAriaLabel(summary: SystemSummary): string {
  const words: string[] = [];
  if (summary.cpuPct !== null) words.push(`CPU ${clampPercent(summary.cpuPct)} percent`);
  if (summary.memUsedPct !== null) {
    words.push(`memory ${clampPercent(summary.memUsedPct)} percent used`);
  }
  if (summary.diskFreeGB !== null) {
    const total = summary.diskTotalGB !== null ? ` of ${formatGB(summary.diskTotalGB)}` : "";
    words.push(`${summary.diskLabel ?? "disk"} ${formatGB(summary.diskFreeGB)} free${total}`);
  }
  return `PC: ${words.join(", ")}. Open Performance`;
}

export interface MachineStatRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

const formatTempC = (value: number) => `${Math.round(value)} °C`;
const formatRpm = (value: number) => `${Math.round(value).toLocaleString("en-GB")} rpm`;

/**
 * The Computer card's rows. A row exists only when the host reported that
 * sensor: a missing fan or temperature is hidden, never drawn as zero.
 */
export function machineStatRows(summary: SystemSummary): ReadonlyArray<MachineStatRow> {
  const rows: MachineStatRow[] = [];
  if (summary.cpuPct !== null) {
    rows.push({ key: "cpu", label: "CPU", value: `${clampPercent(summary.cpuPct)}%` });
  }
  if (summary.memUsedGB !== null && summary.memTotalGB !== null) {
    rows.push({
      key: "memory",
      label: "Memory",
      value: `${summary.memUsedGB.toFixed(1)} of ${summary.memTotalGB.toFixed(1)} GB`,
    });
  }
  if (summary.diskFreeGB !== null) {
    rows.push({ key: "disk", label: "Disk", value: `${formatGB(summary.diskFreeGB)} free` });
  }
  if (summary.cpuTempC !== null) {
    rows.push({ key: "cpuTemp", label: "CPU temperature", value: formatTempC(summary.cpuTempC) });
  }
  if (summary.diskTempC !== null) {
    rows.push({
      key: "diskTemp",
      label: "Disk temperature",
      value: formatTempC(summary.diskTempC),
    });
  }
  summary.fans.forEach((fan, index) => {
    rows.push({ key: `fan:${index}`, label: fan.label, value: formatRpm(fan.rpm) });
  });
  return rows;
}
