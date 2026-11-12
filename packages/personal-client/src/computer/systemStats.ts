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

/** While the gaming PC link is starting, ask again this soon so the line appears quickly. */
export const GAMING_PC_STARTING_POLL_MS = 3_000;

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
  /**
   * The gaming PC, when the server is set up for it. Null when the server is
   * an older build, has no PC configured, or has no fresh reading.
   */
  readonly gamingPc: GamingPc | null;
}

export type GamingPcUser =
  | {
      readonly kind: "game";
      readonly game: "league-match" | "league-open" | "other";
      readonly label: string;
    }
  | {
      readonly kind: "bot";
      readonly bot: string;
      readonly job: "build" | "emulator" | null;
      readonly purpose: string | null;
    };

export type GamingPc =
  | { readonly state: "starting" }
  | {
      readonly state: "on";
      readonly cpuPct: number;
      readonly gpuPct: number | null;
      readonly memUsedGB: number;
      readonly memTotalGB: number;
      readonly memUsedPct: number;
      readonly ageMs: number;
      readonly users: ReadonlyArray<GamingPcUser>;
    };

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

/** Text from the PC: control characters out, runs of space folded, cut to `max`. Empty is null. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    text += code < 0x20 || code === 0x7f ? " " : char;
  }
  const folded = text.replace(/\s+/g, " ").trim().slice(0, max).trim();
  return folded.length === 0 ? null : folded;
}

const GAMES = new Set(["league-match", "league-open", "other"]);

function gamingPcUserOrNull(entry: unknown): GamingPcUser | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (record.kind === "game") {
    const label = cleanText(record.label, 40);
    if (label === null || typeof record.game !== "string" || !GAMES.has(record.game)) return null;
    return { kind: "game", game: record.game as "league-match" | "league-open" | "other", label };
  }
  if (record.kind === "bot") {
    const bot = cleanText(record.bot, 24);
    if (bot === null) return null;
    const job = record.job === "build" || record.job === "emulator" ? record.job : null;
    return { kind: "bot", bot, job, purpose: cleanText(record.purpose, 80) };
  }
  return null;
}

/**
 * The gaming PC part of the summary. Anything that is not a clean "starting"
 * or "on" reading is null, so the line is hidden and never half drawn.
 */
export function parseGamingPc(raw: unknown): GamingPc | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.state === "starting") return { state: "starting" };
  if (record.state !== "on") return null;
  const cpuPct = numberOrNull(record.cpuPct);
  const memUsedGB = numberOrNull(record.memUsedGB);
  const memTotalGB = numberOrNull(record.memTotalGB);
  const memUsedPct = numberOrNull(record.memUsedPct);
  if (cpuPct === null || memUsedGB === null || memTotalGB === null || memUsedPct === null) {
    return null;
  }
  if (memTotalGB <= 0) return null;
  const gpuPct = numberOrNull(record.gpuPct);
  return {
    state: "on",
    cpuPct: clampPercent(cpuPct),
    gpuPct: gpuPct === null ? null : clampPercent(gpuPct),
    memUsedGB,
    memTotalGB,
    memUsedPct: clampPercent(memUsedPct),
    ageMs: numberOrNull(record.ageMs) ?? 0,
    users: Array.isArray(record.users)
      ? record.users.flatMap((entry) => {
          const user = gamingPcUserOrNull(entry);
          return user === null ? [] : [user];
        })
      : [],
  };
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
    gamingPc: parseGamingPc(record.gamingPc),
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

export interface GamingPcPart {
  readonly key: "label" | "cpu" | "ram" | "gpu";
  readonly text: string;
  readonly busy: boolean;
}

/**
 * "Gaming PC · CPU 32% · RAM 12/16 GB · GPU 4%". Nothing while the link is
 * starting or the PC is off. A GPU the PC could not read is left out.
 */
export function gamingPcParts(pc: GamingPc | null): ReadonlyArray<GamingPcPart> {
  if (pc === null || pc.state !== "on") return [];
  const parts: GamingPcPart[] = [
    { key: "label", text: "Gaming PC", busy: false },
    { key: "cpu", text: `CPU ${pc.cpuPct}%`, busy: pc.cpuPct >= BUSY_PERCENT },
    {
      key: "ram",
      text: `RAM ${Math.round(pc.memUsedGB)}/${Math.round(pc.memTotalGB)} GB`,
      busy: pc.memUsedPct >= BUSY_PERCENT,
    },
  ];
  if (pc.gpuPct !== null) {
    parts.push({ key: "gpu", text: `GPU ${pc.gpuPct}%`, busy: pc.gpuPct >= BUSY_PERCENT });
  }
  return parts;
}

const GAME_WORDS = { "league-match": "League match", "league-open": "League open" } as const;
const JOB_WORDS = { build: "APK build", emulator: "emulator" } as const;

const gameText = (user: Extract<GamingPcUser, { kind: "game" }>) =>
  user.game === "other" ? user.label : GAME_WORDS[user.game];

/**
 * "In use: League match, Builder (APK build)". The bot's purpose is left out
 * on purpose: it belongs in the accessibility label and the web tooltip.
 */
export function gamingPcUsersText(pc: GamingPc | null): string | null {
  if (pc === null || pc.state !== "on" || pc.users.length === 0) return null;
  const words = pc.users.map((user) =>
    user.kind === "game"
      ? gameText(user)
      : user.job === null
        ? user.bot
        : `${user.bot} (${JOB_WORDS[user.job]})`,
  );
  return `In use: ${words.join(", ")}`;
}

/** The gaming PC line in words, with who is using it and for what. */
export function gamingPcAriaLabel(pc: GamingPc | null): string | null {
  if (pc === null || pc.state !== "on") return null;
  const words = [
    `CPU ${pc.cpuPct} percent`,
    `memory ${Math.round(pc.memUsedGB)} of ${Math.round(pc.memTotalGB)} GB used`,
  ];
  if (pc.gpuPct !== null) words.push(`GPU ${pc.gpuPct} percent`);
  const games = pc.users.flatMap((user) => (user.kind === "game" ? [gameText(user)] : []));
  const bots = pc.users.flatMap((user) => {
    if (user.kind !== "bot") return [];
    const purpose = user.purpose === null ? "" : ` for ${user.purpose}`;
    const job = user.job === null ? "" : `, ${JOB_WORDS[user.job]}`;
    return [`${user.bot}${purpose}${job}`];
  });
  // "In use" is said once, however many users there are.
  const use =
    games.length > 0
      ? ` In use: ${games.join(", ")}${bots.length > 0 ? `, and by ${bots.join("; ")}` : ""}.`
      : bots.length > 0
        ? ` In use by ${bots.join("; ")}.`
        : "";
  return `Gaming PC: ${words.join(", ")}.${use}`;
}

/**
 * How long to wait before the next summary request: the normal delay, or 3 s
 * while the gaming PC link is still starting (never longer than the normal one).
 */
export function systemPollDelayMs(summary: SystemSummary | null, normalMs: number): number {
  return summary?.gamingPc?.state === "starting"
    ? Math.min(normalMs, GAMING_PC_STARTING_POLL_MS)
    : normalMs;
}
