/**
 * The PC's CPU, RAM and disk for the line under the Bots page header
 * (SystemStatsLine.tsx). The numbers come from
 * `GET /api/personal/performance/summary` (server
 * personal/performance/systemSummaryRoute.ts), which never starts the
 * Performance tab's sampler.
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
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function parseSystemSummary(raw: unknown): SystemSummary | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  return {
    cpuPct: numberOrNull(record.cpuPct),
    memUsedPct: numberOrNull(record.memUsedPct),
    memUsedGB: numberOrNull(record.memUsedGB),
    memTotalGB: numberOrNull(record.memTotalGB),
    diskLabel:
      typeof record.diskLabel === "string" && record.diskLabel.length <= 16
        ? record.diskLabel
        : null,
    diskFreeGB: numberOrNull(record.diskFreeGB),
    diskTotalGB: numberOrNull(record.diskTotalGB),
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
