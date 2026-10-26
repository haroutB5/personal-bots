// Paths, constants and the test overrides of the Linux release runner.
// Overrides exist only with HBOTS_RELEASE_TEST=1 plus HBOTS_RELEASE_TEST_*; the launcher never sets them and a
// run that used them says so in its result.
import path from "node:path";

export const PINNED_NODE = "/home/harout/.local/share/mise/installs/node/24.22.1/bin/node";
export const DEFAULT_HOME = "/home/harout/.personal-bots";
export const DEFAULT_TOOLS = "/home/harout/Claude/AI/dev-team/tools";
export const DEFAULT_APP_SHEET = "/home/harout/Claude/AI/dev-team/apps/personal-bots.md";
export const DEFAULT_APP_HISTORY = "/home/harout/Claude/AI/dev-team/apps/personal-bots-history.md";
export const DEFAULT_REPO = "/home/harout/Claude/AI/personal-bots";
export const HEAVY_LOCK = "/home/harout/.personal-bots/run/omarchy-heavy.lock";
export const UNIT = "hbots.service";
export const PORT = 38472;

export const STANDING_COLUMNS = [
  "personal_bot_threads.pinned_at", "personal_bot_threads.snoozed_until", "personal_bot_threads.marked_unread_at",
  "personal_groups.pinned_at", "personal_groups.snoozed_until", "personal_bots.fallback_enabled",
  "personal_bots.fallback_model_json", "personal_bot_fallbacks.bot_id", "personal_bot_fallbacks.reset_at",
  "personal_chat_resumes.fallback", "personal_secret_requests.mode", "personal_secret_requests.origins_json",
  "personal_secret_requests.placement_json", "personal_memory.temporal_kind", "personal_memory.observed_at",
  "personal_memory.verified_at", "personal_memory.evidence_json", "personal_memory.origin_thread_id",
  "personal_memory.origin_message_id", "personal_memory.conflict",
];

export function loadConfig(env = process.env) {
  const test = env.HBOTS_RELEASE_TEST === "1";
  const t = (key, fallback) => (test && env[`HBOTS_RELEASE_TEST_${key}`] ? env[`HBOTS_RELEASE_TEST_${key}`] : fallback);
  const n = (key, fallback) => Number(t(key, fallback));
  const home = t("HOME", DEFAULT_HOME);
  const here = new URL(".", import.meta.url).pathname.replace(/\/lib\/$/, "");
  return {
    test,
    here,
    home,
    run: path.join(home, "run"),
    releases: path.join(home, "releases"),
    backups: path.join(home, "backups"),
    logs: path.join(home, "logs"),
    baseDir: path.join(home, "dev"),
    stateDir: path.join(home, "dev", "userdata"),
    providerLogs: path.join(home, "dev", "userdata", "logs", "provider"),
    runtimeDir: path.join(home, "dev", "runtime"),
    serverJson: path.join(home, "run", "server.json"),
    currentTxt: path.join(home, "releases", "current.txt"),
    node: t("NODE", PINNED_NODE),
    unit: t("UNIT", UNIT),
    heavyLock: t("LOCK", HEAVY_LOCK),
    toolsDir: t("TOOLS", DEFAULT_TOOLS),
    cli: t("CLI", ""),
    port: n("PORT", PORT),
    lookMs: n("LOOK_MS", 30_000),
    quietLooks: n("QUIET_LOOKS", 4),
    eventsQuietMs: n("EVENTS_QUIET_MS", 90_000),
    cpuBudgetS: Number(t("CPU_BUDGET_S", 0.6)),
    marathonMs: n("MARATHON_MS", 4 * 60 * 60_000),
    staleLeftoverMs: n("STALE_LEFTOVER_MS", 30 * 60_000),
    stableSeconds: n("STABLE_SECONDS", 120),
    startTimeoutMs: n("START_TIMEOUT_MS", 180_000),
    smokeCmd: t("SMOKE_CMD", ""),
    pinsFile: t("PINS", path.join(here, "PINS.json")),
    scope: t("CGROUP", ""),
  };
}

/** Requested run mode from the flags. */
export function modeOf(a) {
  if (a.prepare) return "prepare";
  if (a["guards-only"]) return "guards";
  if (a["dry-run"]) return "dryrun";
  return "run";
}

export function artifactNames(cfg, a) {
  const mode = modeOf(a);
  const suffix = { run: "", dryrun: "-dryrun", prepare: "-prepare", guards: "-guards" }[mode];
  return {
    mode,
    log: path.join(cfg.logs, `restart-${a.version}${suffix}.log`),
    result: path.join(cfg.run, `restart-${a.version}${suffix}-result.json`),
    pid: path.join(cfg.run, `restart-${a.version}${suffix}.pid`),
    seal: path.join(cfg.run, `hbots-${a.version}-seal.json`),
    tools: path.join(cfg.run, `release-tools-${a.version}`),
  };
}
