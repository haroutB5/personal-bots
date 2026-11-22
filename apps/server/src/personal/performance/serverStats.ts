// @effect-diagnostics nodeBuiltinImport:off - spawns the one ssh child.
/**
 * The app server's CPU, RAM and free disk for the Bots page (the Linux box
 * that runs Coolify; app health comes from coolifyHealth.ts).
 *
 * Design (spec: qa/hbots-gamingpc-stats/SPEC.md, the same link pointed at a
 * Linux host): one shared, long-lived ssh stream that is read from memory. A
 * summary request never waits on ssh. It calls `touch` (which may start the
 * link) and `current` (which reads the last reading), both synchronous and
 * free of I/O.
 *
 * Security shape, all of it fixed at compile time:
 * - The command is `ssh <fixed options> <host> <fixed remote command>`. The
 *   script is a constant (serverStatsScript.ts) sent over stdin. No request,
 *   client or file value reaches the command line.
 * - `host` comes from T3CODE_PERSONAL_SERVER_STATS_HOST once, at start, and
 *   must be a plain alias (`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`), so it cannot
 *   begin with `-` or carry an ssh option. Unset or invalid: the feature is off
 *   and no process is ever spawned.
 * - The app stores no credential. ssh uses the server user's key and
 *   `~/.ssh/config` entry, with BatchMode so it never prompts.
 *
 * On the stats server the script only reads, ends itself after 25 lines and
 * runs under `timeout 170`. On the laptop the ssh child is started under
 * `setpriv --pdeathsig KILL`, so the kernel kills it the moment the hbots
 * server dies by any signal (SIGKILL included); no ssh of ours outlives it.
 */
import * as NodeChildProcess from "node:child_process";

import { SERVER_STATS_SCRIPT } from "./serverStatsScript.ts";

// ---------------------------------------------------------------- config

export const SERVER_STATS_HOST_ENV = "T3CODE_PERSONAL_SERVER_STATS_HOST";

export interface ServerStatsConfig {
  readonly host: string;
}

export interface ServerStatsConfigResult {
  readonly config: ServerStatsConfig | null;
  /** One log line when the host was set but unusable; null otherwise. */
  readonly warning: string | null;
}

const HOST_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function parseServerStatsConfig(
  env: Readonly<Record<string, string | undefined>>,
): ServerStatsConfigResult {
  const host = (env[SERVER_STATS_HOST_ENV] ?? "").trim();
  if (host === "") return { config: null, warning: null };
  if (!HOST_ALIAS.test(host)) {
    return {
      config: null,
      warning: `server stats off: ${SERVER_STATS_HOST_ENV} is not a plain ssh host alias`,
    };
  }
  return { config: { host }, warning: null };
}

// ---------------------------------------------------------------- wire types

export type ServerStatsWire =
  | { readonly state: "starting" }
  | {
      readonly state: "on";
      readonly cpuPct: number;
      readonly memUsedGB: number;
      readonly memTotalGB: number;
      readonly memUsedPct: number;
      /** Null when `df /` gave nothing. */
      readonly diskFreeGB: number | null;
      readonly diskTotalGB: number | null;
      readonly ageMs: number;
    };

// ---------------------------------------------------------------- line parsing

/** One raw reading from the server: counters, not yet a percentage. */
export interface ServerSample {
  /** Sum of user, nice, system, idle, iowait, irq, softirq, steal (jiffies). */
  readonly cpuTotal: number;
  /** idle + iowait (jiffies). */
  readonly cpuIdle: number;
  readonly memTotalKb: number;
  readonly memAvailKb: number;
  readonly diskTotalBytes: number | null;
  readonly diskAvailBytes: number | null;
}

const COUNTER = /^\d{1,19}$/;

const counter = (text: string): number | null => {
  if (!COUNTER.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
};

/**
 * Boundary: one stdout line from the server to a raw sample, or null.
 * `hbs1` then 8 CPU counters, MemTotal and MemAvailable in kB, then the disk
 * size and available bytes of `/` (or `- -`).
 */
export function parseServerLine(line: string): ServerSample | null {
  const fields = line.trim().split(" ");
  if (fields.length !== 13 || fields[0] !== "hbs1") return null;
  const cpu: number[] = [];
  for (const field of fields.slice(1, 9)) {
    const value = counter(field);
    if (value === null) return null;
    cpu.push(value);
  }
  const memTotalKb = counter(fields[9]!);
  const memAvailKb = counter(fields[10]!);
  if (memTotalKb === null || memAvailKb === null || memTotalKb <= 0) return null;
  let diskTotalBytes: number | null = null;
  let diskAvailBytes: number | null = null;
  if (!(fields[11] === "-" && fields[12] === "-")) {
    diskTotalBytes = counter(fields[11]!);
    diskAvailBytes = counter(fields[12]!);
    if (diskTotalBytes === null || diskAvailBytes === null || diskTotalBytes <= 0) return null;
  }
  const [user, nice, system, idle, iowait, irq, softirq, steal] = cpu as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    cpuTotal: user + nice + system + idle + iowait + irq + softirq + steal,
    cpuIdle: idle + iowait,
    memTotalKb,
    memAvailKb: Math.min(memAvailKb, memTotalKb),
    diskTotalBytes,
    diskAvailBytes: diskAvailBytes === null ? null : Math.min(diskAvailBytes, diskTotalBytes!),
  };
}

/** CPU use between two samples, 0-100, or null when the counters did not move forward. */
export function cpuPctBetween(prev: ServerSample, next: ServerSample): number | null {
  const total = next.cpuTotal - prev.cpuTotal;
  const idle = next.cpuIdle - prev.cpuIdle;
  if (total <= 0 || idle < 0) return null;
  return Math.min(100, Math.max(0, ((total - idle) / total) * 100));
}

const GB = 1024 ** 3;
const round1 = (value: number) => Math.round(value * 10) / 10;

interface Reading {
  readonly cpuPct: number;
  readonly sample: ServerSample;
  readonly at: number;
}

export function serverStatsWireFrom(
  reading: { readonly cpuPct: number; readonly sample: ServerSample },
  ageMs: number,
): Extract<ServerStatsWire, { state: "on" }> {
  const { sample } = reading;
  const usedKb = Math.max(0, sample.memTotalKb - sample.memAvailKb);
  return {
    state: "on",
    cpuPct: Math.round(reading.cpuPct),
    memUsedGB: round1((usedKb * 1024) / GB),
    memTotalGB: round1((sample.memTotalKb * 1024) / GB),
    memUsedPct: Math.min(100, Math.round((usedKb / sample.memTotalKb) * 100)),
    diskFreeGB: sample.diskAvailBytes === null ? null : round1(sample.diskAvailBytes / GB),
    diskTotalGB: sample.diskTotalBytes === null ? null : round1(sample.diskTotalBytes / GB),
    ageMs,
  };
}

// ---------------------------------------------------------------- the ssh link

/** Fixed. Nothing from a request, a client or the environment goes in. */
export const SERVER_SSH_ARGS: ReadonlyArray<string> = [
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

/** The server's login shell runs this: read the script from stdin, with a hard deadline. */
export const SERVER_REMOTE_COMMAND = "exec timeout 170 sh -s";

/** The one ssh child. `kill` is by the captured handle only. */
export interface LinkHandle {
  onLine: (listener: (line: string) => void) => void;
  /**
   * `detail` is the tail of the child's stderr, for one log line. `forceFail` is
   * true when the link itself was dropped for misbehaving (an over-long line):
   * the run counts as failed however long it had streamed.
   */
  onExit: (listener: (detail: string, forceFail: boolean) => void) => void;
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
/** A stdout line longer than this means a broken or hostile server: the link is dropped. */
export const SERVER_LINE_MAX_CHARS = 64 * 1024;

/**
 * The argv for the ssh child. On Linux ssh runs under `setpriv --pdeathsig KILL`:
 * the kernel then sends it SIGKILL when the hbots server (its parent) dies,
 * however it dies, in every state (connecting, silent, streaming). Elsewhere it
 * runs bare.
 */
export function serverLinkCommand(host: string): { file: string; args: ReadonlyArray<string> } {
  const ssh = ["ssh", ...SERVER_SSH_ARGS, host, SERVER_REMOTE_COMMAND];
  return process.platform === "linux"
    ? { file: "setpriv", args: ["--pdeathsig", "KILL", ...ssh] }
    : { file: "ssh", args: ssh.slice(1) };
}

export function spawnServerLink(host: string): LinkHandle {
  let onLine: (line: string) => void = () => undefined;
  let onExit: (detail: string, forceFail: boolean) => void = () => undefined;
  let killed = false;
  let overflowed = false;
  const stderrTail: string[] = [];
  const command = serverLinkCommand(host);
  const child = NodeChildProcess.spawn(command.file, [...command.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: sshEnvironment(),
  });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(SERVER_STATS_SCRIPT);
  child.stdout?.setEncoding("utf8");
  let pending = "";
  const dropForOverflow = () => {
    overflowed = true;
    pending = "";
    child.stdout?.destroy();
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  };
  child.stdout?.on("data", (chunk: string) => {
    if (overflowed) return;
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line.length > SERVER_LINE_MAX_CHARS) return dropForOverflow();
      if (!killed) onLine(line);
      newline = pending.indexOf("\n");
    }
    if (pending.length > SERVER_LINE_MAX_CHARS) dropForOverflow();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail.push(chunk.trim());
    if (stderrTail.length > 4) stderrTail.shift();
  });
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (killed) return;
    onExit(
      overflowed
        ? "stdout line over 64 KB"
        : stderrTail.join(" | ").replace(/\s+/g, " ").slice(0, 200),
      overflowed,
    );
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
export const SERVER_STATS_STALE_MS = 15_000;
/** The link stops this long after the last page request. */
export const SERVER_STATS_IDLE_MS = 30_000;
/** A connecting child that has not produced a reading by now is killed. */
export const SERVER_STATS_CONNECT_MS = 15_000;
/** A child that streamed at least this long counts as a healthy run (a capped run lasts ~2 min). */
export const SERVER_STATS_HEALTHY_RUN_MS = 20_000;
/** Seconds to wait after the first, second and later failures of a run. */
export const SERVER_STATS_BACKOFF_S: ReadonlyArray<number> = [30, 60, 120];
export const SERVER_STATS_HOUSEKEEPING_MS = 10_000;

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
      /** This child's first sample: CPU needs a second one. */
      readonly first: ServerSample | null;
    }
  | {
      readonly tag: "streaming";
      readonly child: LinkHandle;
      readonly startedAt: number;
      readonly failures: number;
      readonly last: Reading;
    }
  | { readonly tag: "down"; readonly retryAt: number; readonly failures: number };

export interface ServerStatsReader {
  /** False when the feature is not configured: the route adds no key at all. */
  readonly enabled: boolean;
  /** A page asked. Starts the link if it is idle or its backoff has passed. */
  touch: (nowMs: number) => void;
  /** What to serve now: `on`, `starting`, or null (nothing fresh to show). */
  current: (nowMs: number) => ServerStatsWire | null;
  /** Housekeeping, normally run by the 10 s timer. Public for tests. */
  tick: (nowMs: number) => void;
  /** Kills the child; the reader is done. */
  stop: () => void;
}

export interface ServerStatsReaderDeps {
  readonly config: ServerStatsConfig | null;
  readonly spawnLink: (host: string) => LinkHandle;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** Runs `fn` every `ms` until the returned function is called. */
  readonly startTimer: (fn: () => void, ms: number) => () => void;
}

const DISABLED: ServerStatsReader = {
  enabled: false,
  touch: () => undefined,
  current: () => null,
  tick: () => undefined,
  stop: () => undefined,
};

export function makeServerStatsReader(
  deps: Omit<ServerStatsReaderDeps, "now" | "log" | "startTimer"> &
    Partial<Pick<ServerStatsReaderDeps, "now" | "log" | "startTimer">>,
): ServerStatsReader {
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

  const ensureTimer = () => {
    stopTimer ??= startTimer(() => reader.tick(now()), SERVER_STATS_HOUSEKEEPING_MS);
  };
  const clearTimer = () => {
    stopTimer?.();
    stopTimer = null;
  };

  const spawn = (nowMs: number, failures: number, prev: Reading | null) => {
    const child = deps.spawnLink(config.host);
    let badLineLogged = false;
    link = { tag: "connecting", child, since: nowMs, failures, prev, first: null };
    ensureTimer();
    child.onLine((text) => {
      if (link.tag !== "connecting" && link.tag !== "streaming") return;
      if (link.child !== child) return;
      const at = now();
      const sample = parseServerLine(text);
      if (sample === null) {
        if (!badLineLogged) {
          badLineLogged = true;
          log("server stats: skipped a line that is not a reading");
        }
        return;
      }
      if (link.tag === "connecting") {
        const cpu = link.first === null ? null : cpuPctBetween(link.first, sample);
        if (cpu === null) {
          // The first sample of this child (or counters that did not move): wait for the next.
          link = { ...link, first: sample };
          return;
        }
        link = {
          tag: "streaming",
          child,
          startedAt: link.since,
          failures: link.failures,
          last: { cpuPct: cpu, sample, at },
        };
        return;
      }
      const cpu = cpuPctBetween(link.last.sample, sample) ?? link.last.cpuPct;
      link = { ...link, last: { cpuPct: cpu, sample, at } };
    });
    child.onExit((detail, forceFail) => {
      if (link.tag !== "connecting" && link.tag !== "streaming") return;
      if (link.child !== child) return;
      onChildExit(now(), detail, forceFail);
    });
  };

  /** The child ended or was killed with no usable reading: wait before the next try. */
  const fail = (nowMs: number, failures: number, detail: string) => {
    clearTimer();
    const waitS = SERVER_STATS_BACKOFF_S[Math.min(failures, SERVER_STATS_BACKOFF_S.length - 1)]!;
    link = { tag: "down", retryAt: nowMs + waitS * 1000, failures: failures + 1 };
    if (failures === 0) {
      log(`server stats link down, retrying in ${waitS} s${detail === "" ? "" : `: ${detail}`}`);
    }
  };

  const onChildExit = (nowMs: number, detail: string, forceFail: boolean) => {
    if (forceFail && (link.tag === "connecting" || link.tag === "streaming")) {
      fail(nowMs, link.failures, detail);
      return;
    }
    if (link.tag === "streaming") {
      const healthy =
        nowMs - link.startedAt >= SERVER_STATS_HEALTHY_RUN_MS &&
        nowMs - link.last.at <= SERVER_STATS_STALE_MS;
      if (healthy) {
        clearTimer();
        if (nowMs - watchedAt > SERVER_STATS_IDLE_MS) {
          link = { tag: "idle" };
        } else {
          // The script reached its 25-line cap: continue at once, keep serving the last reading.
          spawn(nowMs, 0, link.last);
        }
        return;
      }
      fail(nowMs, link.failures, detail);
      return;
    }
    if (link.tag === "connecting") fail(nowMs, link.failures, detail);
  };

  const reader: ServerStatsReader = {
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
      if (reading !== null && nowMs - reading.at <= SERVER_STATS_STALE_MS) {
        return serverStatsWireFrom(reading, Math.max(0, nowMs - reading.at));
      }
      return link.tag === "connecting" ? { state: "starting" } : null;
    },
    tick: (nowMs) => {
      if (link.tag !== "connecting" && link.tag !== "streaming") return;
      const child = link.child;
      if (nowMs - watchedAt > SERVER_STATS_IDLE_MS) {
        link = { tag: "idle" };
        clearTimer();
        child.kill();
      } else if (link.tag === "streaming" && nowMs - link.last.at > SERVER_STATS_STALE_MS) {
        const failures = link.failures;
        child.kill();
        fail(nowMs, failures, "no reading for 15 s");
      } else if (link.tag === "connecting" && nowMs - link.since > SERVER_STATS_CONNECT_MS) {
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
export function makeLiveServerStatsReader(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void,
): ServerStatsReader {
  const { config, warning } = parseServerStatsConfig(env);
  if (warning !== null) log(warning);
  const reader = makeServerStatsReader({
    config,
    spawnLink: spawnServerLink,
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
