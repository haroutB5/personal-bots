// @effect-diagnostics nodeBuiltinImport:off - spawns ssh and reads the rig's small state files.
/**
 * The gaming PC's CPU, RAM and GPU for the Bots page, plus who is using it.
 *
 * Design (spec: qa/hbots-gamingpc-stats/SPEC.md): one shared, long-lived ssh
 * stream that is read from memory. A summary request never waits on ssh. It
 * calls `touch` (which may start the link) and `current` (which reads the last
 * reading), both synchronous and free of I/O.
 *
 * Security shape, all of it fixed at compile time:
 * - The command is `ssh <fixed options> <host> <fixed remote command>`. The
 *   script is a constant (gamingPcScript.ts) sent over stdin. No request, client
 *   or file value reaches the command line.
 * - `host` comes from T3CODE_PERSONAL_GAMINGPC_HOST once, at start, and must be
 *   a plain alias (`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`), so it cannot begin with
 *   `-` or carry an ssh option. Unset or invalid: the feature is off and no
 *   process is ever spawned.
 * - The app stores no credential. ssh uses the server user's key and
 *   `~/.ssh/config` entry, with BatchMode so it never prompts.
 *
 * On the PC the script only reads, and ends itself after 24 lines. A dropped
 * link leaves it running for at most that long.
 *
 * Optional T3CODE_PERSONAL_GAMINGPC_RIG_DIR names the laptop rig's state
 * directory (`~/.cache/hbots-rig`). hbots then reads `who` and `holder.pid`
 * there (written by tools/rig.sh) to show which bot holds the PC. A change in
 * that format hides the bot row and breaks nothing else.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { PC_STATS_SCRIPT } from "./gamingPcScript.ts";

// ---------------------------------------------------------------- config

export interface GamingPcConfig {
  readonly host: string;
  readonly rigDir: string | null;
}

export interface GamingPcConfigResult {
  readonly config: GamingPcConfig | null;
  /** One log line when the host was set but unusable; null otherwise. */
  readonly warning: string | null;
}

const HOST_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function parseGamingPcConfig(
  env: Readonly<Record<string, string | undefined>>,
): GamingPcConfigResult {
  const host = (env.T3CODE_PERSONAL_GAMINGPC_HOST ?? "").trim();
  if (host === "") return { config: null, warning: null };
  if (!HOST_ALIAS.test(host)) {
    return {
      config: null,
      warning: "gaming PC stats off: T3CODE_PERSONAL_GAMINGPC_HOST is not a plain ssh host alias",
    };
  }
  const rigDir = (env.T3CODE_PERSONAL_GAMINGPC_RIG_DIR ?? "").trim();
  return { config: { host, rigDir: rigDir === "" ? null : rigDir }, warning: null };
}

// ---------------------------------------------------------------- wire types

export type PcGameKind = "game" | "match" | "client";

export interface PcLine {
  readonly cpuPct: number;
  readonly memAvailMb: number;
  readonly memTotalMb: number;
  /** null: the counter had no 3D engine. */
  readonly gpuPct: number | null;
  readonly game: { readonly kind: PcGameKind; readonly process: string } | null;
}

export type PcUserWire =
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

export type GamingPcWire =
  | { readonly state: "starting" }
  | {
      readonly state: "on";
      readonly cpuPct: number;
      readonly gpuPct: number | null;
      readonly memUsedGB: number;
      readonly memTotalGB: number;
      readonly memUsedPct: number;
      readonly ageMs: number;
      readonly users: ReadonlyArray<PcUserWire>;
    };

export interface RigHolder {
  readonly bot: string;
  readonly job: "build" | "emulator" | null;
  readonly purpose: string | null;
}

// ---------------------------------------------------------------- line parsing

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const GAME_KINDS: ReadonlySet<string> = new Set<PcGameKind>(["game", "match", "client"]);

/** Boundary: one stdout line from the PC to a typed reading, or null. */
export function parsePcLine(line: string): PcLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  const { cpuPct, memAvailMb, memTotalMb, gpuPct, game } = raw;
  if (!nonNegative(cpuPct) || !nonNegative(memAvailMb) || !nonNegative(memTotalMb)) return null;
  if (memTotalMb <= 0) return null;
  if (gpuPct !== null && gpuPct !== undefined && !nonNegative(gpuPct)) return null;
  let parsedGame: PcLine["game"] = null;
  if (game !== null && game !== undefined) {
    if (!isRecord(game)) return null;
    if (typeof game.kind !== "string" || !GAME_KINDS.has(game.kind)) return null;
    if (typeof game.process !== "string" || game.process.trim() === "") return null;
    parsedGame = { kind: game.kind as PcGameKind, process: game.process.trim().slice(0, 80) };
  }
  return {
    cpuPct: Math.min(100, cpuPct),
    memAvailMb,
    memTotalMb,
    gpuPct: typeof gpuPct === "number" ? Math.min(100, gpuPct) : null,
    game: parsedGame,
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

const gameUser = (game: NonNullable<PcLine["game"]>): PcUserWire => {
  if (game.kind === "match") return { kind: "game", game: "league-match", label: game.process };
  if (game.kind === "client") return { kind: "game", game: "league-open", label: game.process };
  return { kind: "game", game: "other", label: game.process.replace(/-Win64-Shipping$/i, "") };
};

function wireFrom(
  line: PcLine,
  ageMs: number,
  bot: RigHolder | null,
): Extract<GamingPcWire, { state: "on" }> {
  const usedMb = Math.max(0, line.memTotalMb - line.memAvailMb);
  const users: PcUserWire[] = [];
  if (line.game !== null) users.push(gameUser(line.game));
  if (bot !== null) users.push({ kind: "bot", ...bot });
  return {
    state: "on",
    cpuPct: Math.round(line.cpuPct),
    gpuPct: line.gpuPct === null ? null : Math.round(line.gpuPct),
    memUsedGB: round1(usedMb / 1024),
    memTotalGB: round1(line.memTotalMb / 1024),
    memUsedPct: Math.min(100, Math.round((usedMb / line.memTotalMb) * 100)),
    ageMs,
    users,
  };
}

// ---------------------------------------------------------------- rig holder

export interface RigHolderIo {
  /** `/proc` root; a test points it at a fixture tree. */
  readonly procRoot?: string;
}

const readSmall = async (file: string): Promise<string | null> => {
  try {
    return (await NodeFSP.readFile(file, "utf8")).slice(0, 4096);
  } catch {
    return null;
  }
};

const BOT_MAX = 24;
const PURPOSE_MAX = 80;

/** Removes control characters and cuts to `max` characters. */
const clean = (text: string, max: number) =>
  text
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max)
    .trim();

/** Pure: the `who` file text to a holder, or null when it is not in rig.sh's format. */
export function parseRigWho(text: string): RigHolder | null {
  const [epoch, label, job] = text.split("\n")[0]?.split("\t") ?? [];
  if (epoch === undefined || !/^\d+$/.test(epoch) || label === undefined) return null;
  const whole = clean(label, 200);
  if (whole === "") return null;
  let bot: string;
  let purpose: string | null = null;
  if (/^unnamed bot\b/i.test(whole)) {
    bot = "A bot";
  } else {
    const colon = whole.indexOf(":");
    bot = clean(colon === -1 ? whole : whole.slice(0, colon), BOT_MAX);
    if (colon !== -1) purpose = clean(whole.slice(colon + 1), PURPOSE_MAX) || null;
  }
  if (bot === "") return null;
  const jobText = (job ?? "").trim();
  return {
    bot,
    job: jobText.startsWith("APK build")
      ? "build"
      : jobText.startsWith("emulator")
        ? "emulator"
        : null,
    purpose,
  };
}

/**
 * Which bot holds the gaming PC right now, read from the laptop rig's state
 * directory. It counts only when `holder.pid` names a live process whose
 * command line is rig.sh (a reused pid after a SIGKILL fails this) and the
 * `who` file parses. Any failure is "nobody".
 */
export async function readRigHolder(dir: string, io: RigHolderIo = {}): Promise<RigHolder | null> {
  const procRoot = io.procRoot ?? "/proc";
  const pid = (await readSmall(NodePath.join(dir, "holder.pid")))?.trim() ?? "";
  if (!/^\d{1,10}$/.test(pid)) return null;
  const cmdline = await readSmall(NodePath.join(procRoot, pid, "cmdline"));
  if (cmdline === null) return null;
  const isRigSh = cmdline.split("\0").some((arg) => /(^|\/)rig\.sh$/.test(arg));
  if (!isRigSh) return null;
  const who = await readSmall(NodePath.join(dir, "who"));
  return who === null ? null : parseRigWho(who);
}

// ---------------------------------------------------------------- the ssh link

/** Fixed. Nothing from a request, a client or the environment goes in. */
export const PC_SSH_ARGS: ReadonlyArray<string> = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "LogLevel=ERROR",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "ServerAliveInterval=5",
  "-o",
  "ServerAliveCountMax=2",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
];

/** The PC's default ssh shell is PowerShell: read the script from stdin and run it. */
export const PC_REMOTE_COMMAND = "$s = [Console]::In.ReadToEnd(); Invoke-Expression $s";

/** The one ssh child. `kill` is by the captured handle only. */
export interface LinkHandle {
  onLine: (listener: (line: string) => void) => void;
  /** `detail` is the tail of the child's stderr, for one log line. */
  onExit: (listener: (detail: string) => void) => void;
  kill: () => void;
}

/** ssh needs HOME for its config and keys, and the agent socket if there is one. */
const SSH_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "SSH_AUTH_SOCK", "LANG"] as const;

function sshEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SSH_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** SIGKILL follows a SIGTERM that did not end the child within this long. */
const KILL_ESCALATE_MS = 3_000;

export function spawnPcLink(host: string): LinkHandle {
  let onLine: (line: string) => void = () => undefined;
  let onExit: (detail: string) => void = () => undefined;
  let killed = false;
  const stderrTail: string[] = [];
  const child = NodeChildProcess.spawn("ssh", [...PC_SSH_ARGS, host, PC_REMOTE_COMMAND], {
    stdio: ["pipe", "pipe", "pipe"],
    env: sshEnvironment(),
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(PC_STATS_SCRIPT);
  child.stdout?.setEncoding("utf8");
  if (child.stdout !== null) {
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!killed) onLine(line);
    });
  }
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail.push(chunk.trim());
    if (stderrTail.length > 4) stderrTail.shift();
  });
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (!killed) onExit(stderrTail.join(" | ").replace(/\s+/g, " ").slice(0, 200));
  };
  child.on("error", (error) => {
    stderrTail.push(error.message);
    finish();
  });
  child.on("close", finish);
  return {
    onLine: (listener) => {
      onLine = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
    kill: () => {
      killed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill("SIGTERM");
      } catch {
        return;
      }
      const escalate = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }, KILL_ESCALATE_MS);
      escalate.unref();
      child.once("close", () => clearTimeout(escalate));
    },
  };
}

// ---------------------------------------------------------------- the reader

/** A reading older than this is hidden. */
export const GAMING_PC_STALE_MS = 15_000;
/** The link stops this long after the last page request. */
export const GAMING_PC_IDLE_MS = 30_000;
/** A connecting child that has not produced a line by now is killed. */
export const GAMING_PC_CONNECT_MS = 15_000;
/** A child that streamed at least this long counts as a healthy run (a cap run lasts ~2 min). */
export const GAMING_PC_HEALTHY_RUN_MS = 20_000;
/** Seconds to wait after the first, second and later failures of a run. */
export const GAMING_PC_BACKOFF_S: ReadonlyArray<number> = [30, 60, 120];
export const GAMING_PC_HOUSEKEEPING_MS = 10_000;
export const GAMING_PC_RIG_CACHE_MS = 5_000;

interface Reading {
  readonly line: PcLine;
  readonly at: number;
}

/** One state at a time; a child exists exactly in `connecting` and `streaming`. */
type Link =
  | { readonly tag: "idle" }
  | {
      readonly tag: "connecting";
      readonly child: LinkHandle;
      readonly since: number;
      readonly failures: number;
      /** Kept while a capped child is replaced, so the page keeps its numbers. */
      readonly prev: Reading | null;
    }
  | {
      readonly tag: "streaming";
      readonly child: LinkHandle;
      readonly startedAt: number;
      readonly failures: number;
      readonly last: Reading;
    }
  | { readonly tag: "down"; readonly retryAt: number; readonly failures: number };

export interface GamingPcReader {
  /** False when the feature is not configured: the route adds no key at all. */
  readonly enabled: boolean;
  /** A page asked. Starts the link if it is idle or its backoff has passed. */
  touch: (nowMs: number) => void;
  /** What to serve now: `on`, `starting`, or null (nothing fresh to show). */
  current: (nowMs: number) => GamingPcWire | null;
  /** Housekeeping, normally run by the 10 s timer. Public for tests. */
  tick: (nowMs: number) => void;
  /** Kills the child; the reader is done. */
  stop: () => void;
}

export interface GamingPcReaderDeps {
  readonly config: GamingPcConfig | null;
  readonly spawnLink: (host: string) => LinkHandle;
  readonly readRigHolder: (dir: string) => Promise<RigHolder | null>;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** Runs `fn` every `ms` until the returned function is called. */
  readonly startTimer: (fn: () => void, ms: number) => () => void;
}

const DISABLED: GamingPcReader = {
  enabled: false,
  touch: () => undefined,
  current: () => null,
  tick: () => undefined,
  stop: () => undefined,
};

export function makeGamingPcReader(
  deps: Omit<GamingPcReaderDeps, "now" | "log" | "startTimer"> &
    Partial<Pick<GamingPcReaderDeps, "now" | "log" | "startTimer">>,
): GamingPcReader {
  const config = deps.config;
  if (config === null) return DISABLED;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);
  const startTimer =
    deps.startTimer ??
    ((fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    });

  let link: Link = { tag: "idle" };
  let watchedAt = Number.NEGATIVE_INFINITY;
  let stopTimer: (() => void) | null = null;
  let stopped = false;
  let rig: { readonly value: RigHolder | null; readonly at: number } | null = null;
  let rigAskedAt = Number.NEGATIVE_INFINITY;
  let rigInFlight = false;

  const ensureTimer = () => {
    stopTimer ??= startTimer(() => reader.tick(now()), GAMING_PC_HOUSEKEEPING_MS);
  };
  const clearTimer = () => {
    stopTimer?.();
    stopTimer = null;
  };

  const refreshRig = (nowMs: number) => {
    const dir = config.rigDir;
    if (dir === null || rigInFlight || nowMs - rigAskedAt < GAMING_PC_RIG_CACHE_MS) return;
    rigInFlight = true;
    rigAskedAt = nowMs;
    void deps
      .readRigHolder(dir)
      .catch(() => null)
      .then((value) => {
        rig = { value, at: nowMs };
      })
      .finally(() => {
        rigInFlight = false;
      });
  };

  const spawn = (nowMs: number, failures: number, prev: Reading | null) => {
    const child = deps.spawnLink(config.host);
    let badLineLogged = false;
    link = { tag: "connecting", child, since: nowMs, failures, prev };
    ensureTimer();
    child.onLine((text) => {
      if (link.tag !== "connecting" && link.tag !== "streaming") return;
      if (link.child !== child) return;
      const at = now();
      const line = parsePcLine(text);
      if (line === null) {
        if (!badLineLogged) {
          badLineLogged = true;
          log("gaming PC stats: skipped a line that is not a reading");
        }
        return;
      }
      link = {
        tag: "streaming",
        child,
        startedAt: link.tag === "connecting" ? link.since : link.startedAt,
        failures: link.failures,
        last: { line, at },
      };
      refreshRig(at);
    });
    child.onExit((detail) => {
      if (link.tag !== "connecting" && link.tag !== "streaming") return;
      if (link.child !== child) return;
      onChildExit(now(), detail);
    });
  };

  /** The child ended or was killed with no usable reading: wait before the next try. */
  const fail = (nowMs: number, failures: number, detail: string) => {
    clearTimer();
    const waitS = GAMING_PC_BACKOFF_S[Math.min(failures, GAMING_PC_BACKOFF_S.length - 1)]!;
    link = { tag: "down", retryAt: nowMs + waitS * 1000, failures: failures + 1 };
    if (failures === 0) {
      log(`gaming PC stats link down, retrying in ${waitS} s${detail === "" ? "" : `: ${detail}`}`);
    }
  };

  const onChildExit = (nowMs: number, detail: string) => {
    if (link.tag === "streaming") {
      const healthy =
        nowMs - link.startedAt >= GAMING_PC_HEALTHY_RUN_MS &&
        nowMs - link.last.at <= GAMING_PC_STALE_MS;
      if (healthy) {
        clearTimer();
        if (nowMs - watchedAt > GAMING_PC_IDLE_MS) {
          link = { tag: "idle" };
        } else {
          // The PC loop reached its 24-line cap: continue at once, keep serving the last reading.
          spawn(nowMs, 0, link.last);
        }
        return;
      }
      fail(nowMs, link.failures, detail);
      return;
    }
    if (link.tag === "connecting") fail(nowMs, link.failures, detail);
  };

  const reader: GamingPcReader = {
    enabled: true,
    touch: (nowMs) => {
      if (stopped) return;
      watchedAt = nowMs;
      if (link.tag === "idle") spawn(nowMs, 0, null);
      else if (link.tag === "down" && nowMs >= link.retryAt) spawn(nowMs, link.failures, null);
    },
    current: (nowMs) => {
      const reading =
        link.tag === "streaming" ? link.last : link.tag === "connecting" ? link.prev : null;
      if (reading !== null && nowMs - reading.at <= GAMING_PC_STALE_MS) {
        refreshRig(nowMs);
        const bot = rig !== null && nowMs - rig.at <= GAMING_PC_STALE_MS ? rig.value : null;
        return wireFrom(reading.line, nowMs - reading.at, bot);
      }
      return link.tag === "connecting" ? { state: "starting" } : null;
    },
    tick: (nowMs) => {
      if (link.tag !== "connecting" && link.tag !== "streaming") return;
      const child = link.child;
      if (nowMs - watchedAt > GAMING_PC_IDLE_MS) {
        link = { tag: "idle" };
        clearTimer();
        child.kill();
      } else if (link.tag === "streaming" && nowMs - link.last.at > GAMING_PC_STALE_MS) {
        const failures = link.failures;
        child.kill();
        fail(nowMs, failures, "no reading for 15 s");
      } else if (link.tag === "connecting" && nowMs - link.since > GAMING_PC_CONNECT_MS) {
        const failures = link.failures;
        child.kill();
        fail(nowMs, failures, "no reading within 15 s");
      }
    },
    stop: () => {
      stopped = true;
      clearTimer();
      if (link.tag === "connecting" || link.tag === "streaming") link.child.kill();
      link = { tag: "idle" };
    },
  };
  return reader;
}

/** The reader the server uses: real ssh, the real clock, the server log. */
export function makeLiveGamingPcReader(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): GamingPcReader {
  const { config, warning } = parseGamingPcConfig(env);
  if (warning !== null) log(warning);
  const reader = makeGamingPcReader({
    config,
    spawnLink: spawnPcLink,
    readRigHolder: (dir) => readRigHolder(dir),
    now: Date.now,
    log,
    startTimer: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  });
  if (reader.enabled) {
    // A server that exits without running its finalizers must not leave ssh behind.
    process.once("exit", () => reader.stop());
  }
  return reader;
}
