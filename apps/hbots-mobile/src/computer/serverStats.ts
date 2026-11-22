import {
  BUSY_PERCENT,
  LOW_DISK_SHARE,
  formatGB,
  parseSystemSummary,
  type SystemSummary,
} from "@hbots/personal-client/computer/systemStats";

/**
 * The app server lines under the Bots header, from the summary's `server` and
 * `serverApps` keys. The shared type still has the parked web app's gaming PC
 * field; the phone never reads it.
 */

/** While a server part is still starting, ask again this soon so its line appears quickly. */
export const SERVER_STARTING_POLL_MS = 3_000;

export type ServerStats =
  | { readonly state: "starting" }
  | {
      readonly state: "on";
      readonly cpuPct: number;
      readonly memUsedGB: number;
      readonly memTotalGB: number;
      readonly memUsedPct: number;
      readonly diskFreeGB: number | null;
      readonly diskTotalGB: number | null;
    };

export type ServerAppStatus = "down" | "unhealthy" | "starting" | "unknown";

export interface ServerAppProblem {
  readonly kind: "app" | "db";
  readonly name: string;
  readonly status: ServerAppStatus;
}

export type ServerApps =
  | { readonly state: "starting" }
  | { readonly state: "unreachable" }
  | {
      readonly state: "on";
      readonly appsUp: number;
      readonly appsTotal: number;
      readonly dbsUp: number;
      readonly dbsTotal: number;
      readonly problems: ReadonlyArray<ServerAppProblem>;
    };

/** The laptop summary plus the app server. */
export type PhoneSystemSummary = Omit<SystemSummary, "gamingPc"> & {
  /** Null: the server sends none (not set up, older build) or nothing fresh. */
  readonly server: ServerStats | null;
  readonly serverApps: ServerApps | null;
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));
const count = (value: unknown): number | null => {
  const n = num(value);
  return n === null || n < 0 ? null : Math.floor(n);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Anything not a clean "starting" or "on" reading is null, so the line is hidden, never half drawn. */
export function parseServerStats(raw: unknown): ServerStats | null {
  if (!isRecord(raw)) return null;
  if (raw.state === "starting") return { state: "starting" };
  if (raw.state !== "on") return null;
  const cpuPct = num(raw.cpuPct);
  const memUsedGB = num(raw.memUsedGB);
  const memTotalGB = num(raw.memTotalGB);
  const memUsedPct = num(raw.memUsedPct);
  if (cpuPct === null || memUsedGB === null || memTotalGB === null || memUsedPct === null) {
    return null;
  }
  if (memTotalGB <= 0) return null;
  const diskFreeGB = num(raw.diskFreeGB);
  const diskTotalGB = num(raw.diskTotalGB);
  return {
    state: "on",
    cpuPct: clampPercent(cpuPct),
    memUsedGB,
    memTotalGB,
    memUsedPct: clampPercent(memUsedPct),
    diskFreeGB: diskFreeGB !== null && diskFreeGB >= 0 ? diskFreeGB : null,
    diskTotalGB: diskTotalGB !== null && diskTotalGB > 0 ? diskTotalGB : null,
  };
}

/** Control characters out, runs of space folded, cut to 40. */
function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    text += code < 0x20 || code === 0x7f ? " " : char;
  }
  const folded = text.replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return folded.length === 0 ? null : folded;
}

const STATUSES: ReadonlySet<string> = new Set(["down", "unhealthy", "starting", "unknown"]);

export function parseServerApps(raw: unknown): ServerApps | null {
  if (!isRecord(raw)) return null;
  if (raw.state === "starting") return { state: "starting" };
  if (raw.state === "unreachable") return { state: "unreachable" };
  if (raw.state !== "on") return null;
  const appsUp = count(raw.appsUp);
  const appsTotal = count(raw.appsTotal);
  const dbsUp = count(raw.dbsUp);
  const dbsTotal = count(raw.dbsTotal);
  if (appsUp === null || appsTotal === null || dbsUp === null || dbsTotal === null) return null;
  if (appsUp > appsTotal || dbsUp > dbsTotal) return null;
  const problems = Array.isArray(raw.problems)
    ? raw.problems.flatMap((entry): ServerAppProblem[] => {
        if (!isRecord(entry)) return [];
        const name = cleanName(entry.name);
        const kind = entry.kind === "app" || entry.kind === "db" ? entry.kind : null;
        const status =
          typeof entry.status === "string" && STATUSES.has(entry.status)
            ? (entry.status as ServerAppStatus)
            : null;
        return name === null || kind === null || status === null ? [] : [{ kind, name, status }];
      })
    : [];
  return { state: "on", appsUp, appsTotal, dbsUp, dbsTotal, problems: problems.slice(0, 8) };
}

export function parsePhoneSystemSummary(raw: unknown): PhoneSystemSummary | null {
  const laptop = parseSystemSummary(raw);
  if (laptop === null) return null;
  const { gamingPc: _unused, ...rest } = laptop;
  const record = raw as Record<string, unknown>;
  return {
    ...rest,
    server: parseServerStats(record.server),
    serverApps: parseServerApps(record.serverApps),
  };
}

/** The laptop part, in the shared shape the laptop helpers (systemStatParts, machineStatRows) take. */
export function laptopSummary(summary: PhoneSystemSummary): SystemSummary {
  const { server: _server, serverApps: _apps, ...laptop } = summary;
  return { ...laptop, gamingPc: null };
}

export interface ServerLinePart {
  readonly key: string;
  readonly text: string;
  readonly busy: boolean;
}

/**
 * "Server · CPU 12% · RAM 5/15 GB · Disk 238 GB free". Nothing while the link
 * is starting or the server is not reporting. A disk `df` could not read is left out.
 */
export function serverStatParts(server: ServerStats | null): ReadonlyArray<ServerLinePart> {
  if (server === null || server.state !== "on") return [];
  const parts: ServerLinePart[] = [
    { key: "label", text: "Server", busy: false },
    { key: "cpu", text: `CPU ${server.cpuPct}%`, busy: server.cpuPct >= BUSY_PERCENT },
    {
      key: "ram",
      text: `RAM ${Math.round(server.memUsedGB)}/${Math.round(server.memTotalGB)} GB`,
      busy: server.memUsedPct >= BUSY_PERCENT,
    },
  ];
  if (server.diskFreeGB !== null) {
    const low =
      server.diskTotalGB !== null && server.diskFreeGB / server.diskTotalGB < LOW_DISK_SHARE;
    parts.push({ key: "disk", text: `Disk ${formatGB(server.diskFreeGB)} free`, busy: low });
  }
  return parts;
}

const STATUS_WORDS: Readonly<Record<ServerAppStatus, string>> = {
  down: "down",
  unhealthy: "unhealthy",
  starting: "starting",
  unknown: "status unknown",
};

const problemText = (problem: ServerAppProblem) =>
  `${problem.name} ${STATUS_WORDS[problem.status]}`;

/**
 * "Apps 8/8 up · DB ok", "Apps 7/8 up · matchday down · DB ok",
 * "Apps 8/8 up · apps-postgres down", or "Coolify unreachable". Nothing while
 * the first answer is on its way. A problem part is inked amber.
 */
export function serverAppsParts(apps: ServerApps | null): ReadonlyArray<ServerLinePart> {
  if (apps === null || apps.state === "starting") return [];
  if (apps.state === "unreachable") {
    return [{ key: "unreachable", text: "Coolify unreachable", busy: true }];
  }
  const parts: ServerLinePart[] = [
    {
      key: "apps",
      text: `Apps ${apps.appsUp}/${apps.appsTotal} up`,
      busy: apps.appsUp < apps.appsTotal,
    },
  ];
  const appProblems = apps.problems.filter((problem) => problem.kind === "app");
  if (appProblems.length > 0) {
    parts.push({ key: "appProblems", text: appProblems.map(problemText).join(", "), busy: true });
  }
  if (apps.dbsTotal > 0) {
    const dbProblems = apps.problems.filter((problem) => problem.kind === "db");
    if (apps.dbsUp === apps.dbsTotal) {
      parts.push({ key: "db", text: apps.dbsTotal === 1 ? "DB ok" : "DBs ok", busy: false });
    } else if (dbProblems.length > 0) {
      parts.push({ key: "db", text: dbProblems.map(problemText).join(", "), busy: true });
    } else {
      parts.push({ key: "db", text: `DB ${apps.dbsUp}/${apps.dbsTotal} up`, busy: true });
    }
  }
  return parts;
}

/** The two server lines in words, for screen readers. Null when neither line shows. */
export function serverAriaLabel(
  server: ServerStats | null,
  apps: ServerApps | null,
): string | null {
  const words: string[] = [];
  if (server !== null && server.state === "on") {
    const stats = [
      `CPU ${server.cpuPct} percent`,
      `memory ${Math.round(server.memUsedGB)} of ${Math.round(server.memTotalGB)} GB used`,
    ];
    if (server.diskFreeGB !== null) stats.push(`disk ${formatGB(server.diskFreeGB)} free`);
    words.push(`Server: ${stats.join(", ")}.`);
  }
  const appParts = serverAppsParts(apps);
  if (appParts.length > 0) words.push(`${appParts.map((part) => part.text).join(", ")}.`);
  return words.length === 0 ? null : words.join(" ");
}

/**
 * The app health as one plain string for the widgets, or null when it does not show. Problems
 * come first ("matchday down · Apps 7/8 up · DB ok") so a narrow widget cuts the counts, not the name.
 */
export function serverAppsText(apps: ServerApps | null): string | null {
  const parts = serverAppsParts(apps);
  if (parts.length === 0) return null;
  const named = (part: ServerLinePart) =>
    part.key === "appProblems" || (part.key === "db" && part.busy);
  return [...parts.filter(named), ...parts.filter((part) => !named(part))]
    .map((part) => part.text)
    .join(" · ");
}

/** Whether the app health has a problem worth amber (anything but all up and reachable). */
export function serverAppsTroubled(apps: ServerApps | null): boolean {
  return serverAppsParts(apps).some((part) => part.busy);
}

/**
 * How long to wait before the next summary request: the normal delay, or 3 s
 * while a server part is still starting (never longer than the normal one).
 */
export function phonePollDelayMs(summary: PhoneSystemSummary | null, normalMs: number): number {
  const starting =
    summary?.server?.state === "starting" || summary?.serverApps?.state === "starting";
  return starting ? Math.min(normalMs, SERVER_STARTING_POLL_MS) : normalMs;
}
