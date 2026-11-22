// @effect-diagnostics globalFetch:off - one read-only GET per list, at most once a minute, to a fixed origin.
/**
 * App health from the Coolify v4 API for the Bots page: "Apps 8/8 up · DB ok".
 *
 * - T3CODE_PERSONAL_COOLIFY_URL names the Coolify origin (e.g.
 *   `http://100.117.220.14:8000`, a Tailscale address). Unset or not a plain
 *   http(s) origin: the feature is off and nothing is ever fetched.
 * - The API token is the saved secret COOLIFY_API_TOKEN, read by the server
 *   from its own secret store (secrets/savedSecretValue.ts) just before a
 *   fetch. It goes in the Authorization header of three GETs to that origin
 *   and nowhere else: never in a log line (failures log only an HTTP status or
 *   an error class name), never in the reading, never in a response.
 * - Fetches are driven by page requests (`touch`), at most one round every
 *   60 s, never while one is in flight, and redirects are refused, so the
 *   header never leaves the configured origin.
 * - When the API cannot be read (no token, network error, timeout, non-200,
 *   bad JSON) the reading is `unreachable`, never a stale or partial count.
 */
import * as Redacted from "effect/Redacted";

// ---------------------------------------------------------------- config

export const COOLIFY_URL_ENV = "T3CODE_PERSONAL_COOLIFY_URL";
export const COOLIFY_TOKEN_SECRET_NAME = "COOLIFY_API_TOKEN";

export interface CoolifyConfig {
  /** Origin only, e.g. `http://100.117.220.14:8000`. */
  readonly origin: string;
}

export function parseCoolifyConfig(env: Readonly<Record<string, string | undefined>>): {
  readonly config: CoolifyConfig | null;
  readonly warning: string | null;
} {
  const raw = (env[COOLIFY_URL_ENV] ?? "").trim();
  if (raw === "") return { config: null, warning: null };
  const off = {
    config: null,
    warning: `Coolify health off: ${COOLIFY_URL_ENV} is not a plain http(s) origin`,
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return off;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return off;
  if (url.username !== "" || url.password !== "") return off;
  if (url.search !== "" || url.hash !== "") return off;
  if (url.pathname !== "/" && url.pathname !== "") return off;
  return { config: { origin: url.origin }, warning: null };
}

// ---------------------------------------------------------------- status mapping

export type CoolifyItemStatus = "up" | "down" | "unhealthy" | "starting" | "unknown";

/**
 * Coolify v4 status text to one word. `running:healthy` and `running:unknown`
 * (no healthcheck defined) are up; `running:unhealthy` and `degraded:*` are
 * unhealthy; `exited:*`, `stopped`, `dead` and `paused` are down;
 * `restarting:*` and `starting:*` are starting; anything else is unknown,
 * which counts as a problem so it is never hidden.
 */
export function mapCoolifyStatus(status: unknown): CoolifyItemStatus {
  if (typeof status !== "string") return "unknown";
  const [state = "", health = ""] = status.trim().toLowerCase().split(":", 2);
  switch (state) {
    case "running":
      return health === "unhealthy" ? "unhealthy" : "up";
    case "degraded":
      return "unhealthy";
    case "exited":
    case "stopped":
    case "dead":
    case "paused":
      return "down";
    case "restarting":
    case "starting":
      return "starting";
    default:
      return "unknown";
  }
}

export interface CoolifyProblem {
  readonly kind: "app" | "db";
  readonly name: string;
  readonly status: Exclude<CoolifyItemStatus, "up">;
}

export interface CoolifySummary {
  readonly appsUp: number;
  readonly appsTotal: number;
  readonly dbsUp: number;
  readonly dbsTotal: number;
  /** Apps first, then databases, at most MAX_PROBLEMS. */
  readonly problems: ReadonlyArray<CoolifyProblem>;
}

export const COOLIFY_MAX_PROBLEMS = 8;
const NAME_MAX = 40;

const cleanName = (value: unknown): string => {
  if (typeof value !== "string") return "unnamed";
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return text === "" ? "unnamed" : text;
};

const items = (list: ReadonlyArray<unknown>) =>
  list.map((entry) => {
    const record =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    return { name: cleanName(record.name), status: mapCoolifyStatus(record.status) };
  });

/**
 * The three lists to one summary. Applications and services count as apps,
 * databases as DBs. Only names and mapped statuses are kept: nothing else
 * from Coolify's (large) answer reaches the reading. Null when a list is not
 * an array (an error body, a changed API).
 */
export function summariseCoolify(lists: {
  readonly applications: unknown;
  readonly services: unknown;
  readonly databases: unknown;
}): CoolifySummary | null {
  const { applications, services, databases } = lists;
  if (!Array.isArray(applications) || !Array.isArray(services) || !Array.isArray(databases)) {
    return null;
  }
  const apps = [...items(applications), ...items(services)];
  const dbs = items(databases);
  const problems: CoolifyProblem[] = [];
  for (const [kind, list] of [
    ["app", apps],
    ["db", dbs],
  ] as const) {
    for (const item of list) {
      if (item.status !== "up" && problems.length < COOLIFY_MAX_PROBLEMS) {
        problems.push({ kind, name: item.name, status: item.status });
      }
    }
  }
  return {
    appsUp: apps.filter((item) => item.status === "up").length,
    appsTotal: apps.length,
    dbsUp: dbs.filter((item) => item.status === "up").length,
    dbsTotal: dbs.length,
    problems,
  };
}

// ---------------------------------------------------------------- wire

export type CoolifyHealthWire =
  | { readonly state: "starting" }
  | { readonly state: "unreachable" }
  | ({ readonly state: "on"; readonly ageMs: number } & CoolifySummary);

// ---------------------------------------------------------------- fetching

export type CoolifyListName = "applications" | "services" | "databases";

export type CoolifyFetchResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: string };

/** Fetches one list. The token is only ever put in the Authorization header. */
export type CoolifyFetchList = (
  origin: string,
  list: CoolifyListName,
  token: Redacted.Redacted<string>,
) => Promise<CoolifyFetchResult>;

export const COOLIFY_FETCH_TIMEOUT_MS = 10_000;
/** Eight apps came to 114 KB on 22 Nov 2026; a body past this is refused. */
export const COOLIFY_MAX_BODY_CHARS = 4 * 1024 * 1024;

export const fetchCoolifyList: CoolifyFetchList = async (origin, list, token) => {
  try {
    const response = await fetch(`${origin}/api/v1/${list}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${Redacted.value(token)}` },
      redirect: "error",
      signal: AbortSignal.timeout(COOLIFY_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `HTTP ${response.status}` };
    }
    const text = await response.text();
    if (text.length > COOLIFY_MAX_BODY_CHARS) return { ok: false, reason: "answer too large" };
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch (error) {
    // Only the class name: a message could quote a header or the address.
    return {
      ok: false,
      reason: error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "error",
    };
  }
};

// ---------------------------------------------------------------- the reader

/** One fetch round at most this often. */
export const COOLIFY_POLL_MS = 60_000;
/** A good reading older than this (nobody looked for a while) is not served. */
export const COOLIFY_STALE_MS = 3 * 60_000;

export interface CoolifyHealthReader {
  /** False when the feature is not configured: the route adds no key at all. */
  readonly enabled: boolean;
  /**
   * A page asked. Starts a fetch round when the last one began 60 s ago or
   * more and none is in flight. `readToken` is called only for that round.
   */
  touch: (nowMs: number, readToken: () => Promise<Redacted.Redacted<string> | null>) => void;
  current: (nowMs: number) => CoolifyHealthWire | null;
  /** Resolves when the round in flight (if any) has finished. Tests only. */
  settled: () => Promise<void>;
}

const DISABLED: CoolifyHealthReader = {
  enabled: false,
  touch: () => undefined,
  current: () => null,
  settled: () => Promise.resolve(),
};

export function makeCoolifyHealthReader(deps: {
  readonly config: CoolifyConfig | null;
  readonly fetchList?: CoolifyFetchList;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}): CoolifyHealthReader {
  const config = deps.config;
  if (config === null) return DISABLED;
  const fetchList = deps.fetchList ?? fetchCoolifyList;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);

  let attemptAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;
  let last: { readonly summary: CoolifySummary; readonly at: number } | null = null;
  let unreachable = false;
  let loggedReason: string | null = null;

  const failed = (reason: string) => {
    unreachable = true;
    if (loggedReason !== reason) {
      loggedReason = reason;
      log(`Coolify health unreachable: ${reason}`);
    }
  };

  const round = async (readToken: () => Promise<Redacted.Redacted<string> | null>) => {
    const token = await readToken().catch(() => null);
    if (token === null) return failed(`${COOLIFY_TOKEN_SECRET_NAME} is not saved`);
    const names: ReadonlyArray<CoolifyListName> = ["applications", "services", "databases"];
    const results = await Promise.all(
      names.map((name) =>
        fetchList(config.origin, name, token).catch((): CoolifyFetchResult => ({
          ok: false,
          reason: "error",
        })),
      ),
    );
    const bad = results.find((result) => !result.ok);
    if (bad !== undefined && !bad.ok) return failed(bad.reason);
    const [applications, services, databases] = results.map((result) =>
      result.ok ? result.body : null,
    );
    const summary = summariseCoolify({ applications, services, databases });
    if (summary === null) return failed("an answer was not a list");
    last = { summary, at: now() };
    unreachable = false;
    if (loggedReason !== null) log("Coolify health reachable again");
    loggedReason = null;
  };

  return {
    enabled: true,
    touch: (nowMs, readToken) => {
      if (inFlight !== null || nowMs - attemptAt < COOLIFY_POLL_MS) return;
      attemptAt = nowMs;
      inFlight = round(readToken)
        .catch(() => failed("error"))
        .finally(() => {
          inFlight = null;
        });
    },
    current: (nowMs) => {
      if (unreachable) return { state: "unreachable" };
      if (last === null || nowMs - last.at > COOLIFY_STALE_MS) return { state: "starting" };
      return { state: "on", ageMs: Math.max(0, nowMs - last.at), ...last.summary };
    },
    settled: () => inFlight ?? Promise.resolve(),
  };
}

/** The reader the server uses: real fetch, the real clock, the server log. */
export function makeLiveCoolifyHealthReader(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): CoolifyHealthReader {
  const { config, warning } = parseCoolifyConfig(env);
  if (warning !== null) log(warning);
  return makeCoolifyHealthReader({ config, log });
}
