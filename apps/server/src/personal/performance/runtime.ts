// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
/**
 * The real-world wiring of the Performance sampler: spawn the PowerShell
 * counter helper, read the two sensor endpoints, measure folder sizes at low
 * priority, and hold the sampler singleton for the process's lifetime.
 *
 * Everything here is deliberately plain Node (no Effect services): the
 * sampler is a long-lived machine-facing object with its own lifecycle, and
 * the one thing that needs the app's services (mapping session ids to bots)
 * is passed in as a function built by the route, which does have them.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFileURL from "node:url";
import * as NodeFS from "node:fs";
import * as NodeFSPromises from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { PerformanceStatics } from "@t3tools/contracts";

import { resolveWindowsPowerShell } from "../../provider/processTree.ts";
import type { HelperChild } from "./counterSample.ts";
import { LinuxSensorReader } from "./linuxSensors.ts";
import {
  PerformanceSampler,
  type DiskUsage,
  type HelperHandle,
  type PerformanceSamplerDeps,
} from "./performanceSampler.ts";
import { PERF_HELPER_SCRIPT } from "./perfHelperScript.ts";
import { SensorReaders } from "./sensors.ts";

/** The counter helper's home: `<baseDir>/personal/performance/`. */
export function performanceDir(baseDir: string): string {
  return NodePath.join(baseDir, "personal", "performance");
}

/**
 * The release folders. The live data roots (dev, prod) keep `backups` and
 * `releases` beside the root, like `personalRunDir` does for `run`; every
 * other root (throwaway servers) keeps them inside - or, in practice, has
 * none.
 */
export function releaseFolders(baseDir: string): {
  readonly backups: string;
  readonly releases: string;
} {
  const trimmed = baseDir.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = (cut >= 0 ? trimmed.slice(cut + 1) : trimmed).toLowerCase();
  if (base !== "dev" && base !== "prod") {
    return {
      backups: NodePath.join(trimmed, "backups"),
      releases: NodePath.join(trimmed, "releases"),
    };
  }
  // Keep the input's own separator, so a Windows path stays a Windows path
  // even when this runs on Linux (tests) and the other way round.
  const root = cut > 0 ? trimmed.slice(0, cut) : cut === 0 ? trimmed.slice(0, 1) : ".";
  const sep = cut > 0 ? trimmed[cut]! : cut === 0 ? "" : NodePath.sep;
  return { backups: `${root}${sep}backups`, releases: `${root}${sep}releases` };
}

/** The session id a provider CLI process carries on its command line. */
export function sessionIdFromCommandLine(cmd: string): string | null {
  const match = /--session-id(?:=|\s+)([0-9a-fA-F][0-9a-fA-F-]{7,})/.exec(cmd);
  return match === null ? null : match[1]!.toLowerCase();
}

/** The resume id: an older CLI invocation resumes an existing session. */
export function resumeIdFromCommandLine(cmd: string): string | null {
  const match = /--resume(?:=|\s+)([0-9a-fA-F][0-9a-fA-F-]{7,})/.exec(cmd);
  return match === null ? null : match[1]!.toLowerCase();
}

/** `pid -> sessionId` for the children whose command line names one. */
export function childSessionIds(
  children: ReadonlyArray<HelperChild>,
): ReadonlyArray<{ readonly pid: number; readonly sessionId: string }> {
  const out: Array<{ pid: number; sessionId: string }> = [];
  for (const child of children) {
    const session = sessionIdFromCommandLine(child.cmd) ?? resumeIdFromCommandLine(child.cmd);
    if (session !== null) out.push({ pid: child.pid, sessionId: session });
  }
  return out;
}

export interface RuntimeDeps {
  readonly baseDir: string;
  readonly log?: (line: string) => void;
  readonly startedAtMs: number;
  readonly hbotsVersion?: () => string | null;
}

export function writeHelperScript(baseDir: string): Promise<string> {
  const dir = performanceDir(baseDir);
  const file = NodePath.join(dir, "perf-helper.ps1");
  return NodeFSPromises.mkdir(dir, { recursive: true })
    .then(() => NodeFSPromises.writeFile(file, PERF_HELPER_SCRIPT, { encoding: "utf8" }))
    .then(() => file);
}

/**
 * One long-lived PowerShell reading counters. The handle exists immediately;
 * the process starts once the script file is on disk. `kill()` on a handle
 * whose process has not started yet is a no-op, and `kill()` is by captured
 * PID only (the fleet's rule: never by pattern).
 */
export function spawnCounterHelper(
  baseDir: string,
  parentPid: number,
  tickMs: number,
  options: { readonly log?: (line: string) => void } = {},
): HelperHandle {
  let child: NodeChildProcess.ChildProcess | null = null;
  let killed = false;
  let onLine: (line: string) => void = () => undefined;
  let onExit: () => void = () => undefined;
  const stderrTail: string[] = [];

  void writeHelperScript(baseDir)
    .catch(() => null)
    .then((file) => {
      if (killed || file === null) return;
      const powershell = resolveWindowsPowerShell();
      const spawned = NodeChildProcess.spawn(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          file,
          "-ParentPid",
          String(parentPid),
          "-TickMs",
          String(tickMs),
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      child = spawned;
      spawned.stdout?.setEncoding("utf8");
      if (spawned.stdout !== null) {
        const rl = NodeReadline.createInterface({ input: spawned.stdout });
        rl.on("line", (line) => onLine(line));
      }
      spawned.stderr?.setEncoding("utf8");
      spawned.stderr?.on("data", (chunk: string) => {
        stderrTail.push(chunk.trim());
        if (stderrTail.length > 4) stderrTail.shift();
      });
      spawned.on("error", () => {
        options.log?.("performance counter helper failed to start");
      });
      spawned.on("exit", () => {
        child = null;
        if (stderrTail.length > 0) {
          options.log?.(
            `performance counter helper stderr: ${stderrTail.join(" | ").slice(0, 400)}`,
          );
          stderrTail.length = 0;
        }
        // The sampler decides whether and when to restart; a plain stop is ours.
        if (!killed) onExit();
      });
    });

  return {
    get pid() {
      return child?.pid ?? null;
    },
    onLine: (listener) => {
      onLine = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
    kill: () => {
      killed = true;
      const current = child;
      child = null;
      if (current !== null && current.pid !== undefined && current.exitCode === null) {
        try {
          current.kill();
        } catch {
          // Already gone; nothing to end.
        }
      }
    },
  };
}

/**
 * The Linux helper script beside this server: the source file in a checkout,
 * the bundled sibling entry after a release build (the same rule the Claude
 * history worker uses).
 */
export function linuxHelperScriptPath(): string {
  return NodeFileURL.fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "../../perf-linux-helper.ts" : "./perf-linux-helper.mjs",
      import.meta.url,
    ),
  );
}

/**
 * One long-lived Node process reading `/proc`, the Linux counterpart of
 * `spawnCounterHelper`. It prints the same JSON lines, so the sampler is
 * unchanged. `kill()` is by captured PID only, never by pattern.
 */
export function spawnLinuxCounterHelper(
  parentPid: number,
  tickMs: number,
  options: { readonly log?: (line: string) => void } = {},
): HelperHandle {
  let child: NodeChildProcess.ChildProcess | null = null;
  let killed = false;
  let onLine: (line: string) => void = () => undefined;
  let onExit: () => void = () => undefined;
  const stderrTail: string[] = [];

  try {
    const spawned = NodeChildProcess.spawn(
      process.execPath,
      [
        linuxHelperScriptPath(),
        "--parent-pid",
        String(parentPid),
        "--tick-ms",
        String(tickMs),
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    child = spawned;
    spawned.stdout?.setEncoding("utf8");
    if (spawned.stdout !== null) {
      const rl = NodeReadline.createInterface({ input: spawned.stdout });
      rl.on("line", (line) => onLine(line));
    }
    spawned.stderr?.setEncoding("utf8");
    spawned.stderr?.on("data", (chunk: string) => {
      stderrTail.push(chunk.trim());
      if (stderrTail.length > 4) stderrTail.shift();
    });
    spawned.on("error", () => {
      options.log?.("performance counter helper failed to start");
    });
    spawned.on("exit", () => {
      child = null;
      if (stderrTail.length > 0) {
        options.log?.(
          `performance counter helper stderr: ${stderrTail.join(" | ").slice(0, 400)}`,
        );
        stderrTail.length = 0;
      }
      if (!killed) onExit();
    });
  } catch {
    options.log?.("performance counter helper failed to start");
  }

  return {
    get pid() {
      return child?.pid ?? null;
    },
    onLine: (listener) => {
      onLine = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
    kill: () => {
      killed = true;
      const current = child;
      child = null;
      if (current !== null && current.pid !== undefined && current.exitCode === null) {
        try {
          current.kill();
        } catch {
          // Already gone; nothing to end.
        }
      }
    },
  };
}

/**
 * The size of a folder in bytes, walking it without following links and at
 * most `dirConcurrency` folders in flight. Null when the folder does not
 * exist. This runs at most every ten minutes, from the slow side of the
 * sampler, so its I/O never sits on the sampling path.
 */
export async function sizeOfDirectory(
  dir: string,
  deps: { readonly readdir?: (path: string) => Promise<NodeFS.Dirent[]> } = {},
): Promise<number | null> {
  const readdir =
    deps.readdir ?? ((path: string) => NodeFSPromises.readdir(path, { withFileTypes: true }));
  const dirConcurrency = 8;
  let total = 0;
  let queue: string[] = [dir];
  let found = false;
  while (queue.length > 0) {
    const batch = queue.splice(0, dirConcurrency);
    const results = await Promise.all(
      batch.map(async (current) => {
        let entries: NodeFS.Dirent[];
        try {
          entries = await readdir(current);
        } catch {
          return { dirs: [] as string[], bytes: 0 };
        }
        found = true;
        const dirs: string[] = [];
        let bytes = 0;
        const files: string[] = [];
        for (const entry of entries) {
          const full = NodePath.join(current, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) dirs.push(full);
          else if (entry.isFile()) files.push(full);
        }
        const sized = await Promise.all(
          files.map(async (file) => {
            try {
              return (await NodeFSPromises.stat(file)).size;
            } catch {
              // A file that vanished mid-walk is not an error.
              return 0;
            }
          }),
        );
        for (const size of sized) bytes += size;
        return { dirs, bytes };
      }),
    );
    for (const result of results) {
      total += result.bytes;
      queue = queue.concat(result.dirs);
    }
  }
  return found ? total : null;
}

/** Folder sizes for the storage card, with the backups count. */
export async function readDiskUsage(baseDir: string): Promise<DiskUsage | null> {
  const folders = releaseFolders(baseDir);
  const [data, backups, releases] = await Promise.all([
    sizeOfDirectory(baseDir),
    sizeOfDirectory(folders.backups),
    sizeOfDirectory(folders.releases),
  ]);
  let backupsCount: number | null = null;
  try {
    const entries = await NodeFSPromises.readdir(folders.backups, { withFileTypes: true });
    backupsCount = entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    backupsCount = null;
  }
  const gb = (bytes: number | null): number | null =>
    bytes === null ? null : Math.round((bytes / 1024 ** 3) * 100) / 100;
  return {
    dataGB: gb(data),
    backupsGB: gb(backups),
    backupsCount,
    releasesGB: gb(releases),
  };
}

export interface BuildSamplerDeps extends RuntimeDeps {
  readonly attribute: NonNullable<PerformanceSamplerDeps["attribute"]>;
  readonly readStatics: () => PerformanceStatics;
  readonly serverPid?: number;
  readonly platform?: NodeJS.Platform;
  readonly tickMs?: number;
  readonly stopGraceMs?: number;
  readonly now?: () => number;
}

/** Build (or reuse) the process-wide sampler with the real machine deps. */
export function buildPerformanceSampler(deps: BuildSamplerDeps): PerformanceSampler {
  if (sampler !== null) return sampler;
  const log = deps.log ?? (() => undefined);
  const platform = deps.platform ?? process.platform;
  const serverPid = deps.serverPid ?? process.pid;
  // Windows asks its two sensor apps over loopback HTTP; Linux reads sysfs.
  const sensors =
    platform === "win32"
      ? new SensorReaders()
      : new LinuxSensorReader();
  const now = deps.now ?? (() => Date.now());
  sampler = new PerformanceSampler({
    platform,
    now,
    serverPid,
    startHelper: () => {
      if (platform === "win32") {
        log("performance counter helper starting");
        return spawnCounterHelper(deps.baseDir, serverPid, deps.tickMs ?? 2_000, { log });
      }
      if (platform === "linux") {
        // A single-executable release has no sibling script to run; sampling
        // keeps the os-level CPU fallback instead of spawning nothing forever.
        if (!NodeFS.existsSync(linuxHelperScriptPath())) return null;
        log("performance counter helper starting (linux)");
        return spawnLinuxCounterHelper(serverPid, deps.tickMs ?? 2_000, { log });
      }
      return null;
    },
    readSensors: () => sensors.read(),
    attribute: deps.attribute,
    readDiskUsage: () => readDiskUsage(deps.baseDir),
    readStatics: () => ({ ...deps.readStatics(), hbotsStartedAt: deps.startedAtMs }),
    log,
    ...(deps.tickMs === undefined ? {} : { tickMs: deps.tickMs }),
    ...(deps.stopGraceMs === undefined ? {} : { stopGraceMs: deps.stopGraceMs }),
  });
  return sampler;
}

/** The one sampler of this server process. */
let sampler: PerformanceSampler | null = null;

/** For tests and the version banner: when this process started. */
export function processStartedAt(now = Date.now()): number {
  return now - Math.round(process.uptime() * 1000);
}
