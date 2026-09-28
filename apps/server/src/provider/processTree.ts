// @effect-diagnostics nodeBuiltinImport:off
/**
 * Ends the processes a provider session started, by the session's own PID.
 *
 * A bot's shell command (Claude Code's Bash tool, a Codex exec) runs as a
 * descendant of the provider process the session spawned. Stopping the session
 * ends that provider process, but on Windows a parent exiting does not end its
 * children: a chat deleted mid-turn left its `sleep` running until it finished
 * on its own (1.49.0). So a stop that asks for it ends the provider process's
 * descendants first, while the parent is still alive and the links can still
 * be walked.
 *
 * Only PIDs reached from the session's own recorded PID are touched, and each
 * is killed by number. Never by image name, window or filter: a broad
 * `taskkill` once closed every window on the owner's PC.
 *
 * Windows reuses PIDs, and a process keeps its parent's PID after that parent
 * died, so a stranger can name our PID as its parent. A child only counts when
 * it was created after its parent.
 *
 * @module provider/processTree
 */
import { execFile } from "node:child_process";

import * as Effect from "effect/Effect";

export interface ProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly name: string;
  /** Creation time in epoch ms; null when the platform did not report one. */
  readonly createdAtMs: number | null;
}

/**
 * Every live descendant of `rootPid`, parents before their children. The root
 * itself is not included, and neither is this server process or its parent.
 */
export function descendantsOf(
  snapshot: ReadonlyArray<ProcessEntry>,
  rootPid: number,
  protectedPids: ReadonlyArray<number> = [process.pid, process.ppid],
): ProcessEntry[] {
  const byParent = new Map<number, ProcessEntry[]>();
  for (const entry of snapshot) {
    if (entry.pid === entry.parentPid) continue;
    const siblings = byParent.get(entry.parentPid);
    if (siblings === undefined) byParent.set(entry.parentPid, [entry]);
    else siblings.push(entry);
  }
  const byPid = new Map(snapshot.map((entry) => [entry.pid, entry] as const));
  const out: ProcessEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: ProcessEntry[] = [];
  const enqueueChildren = (parentPid: number) => {
    const parent = byPid.get(parentPid);
    for (const child of byParent.get(parentPid) ?? []) {
      if (seen.has(child.pid) || protectedPids.includes(child.pid) || child.pid <= 4) continue;
      // A process that predates its "parent" names a dead process whose PID
      // was reused; it is not ours.
      if (
        parent?.createdAtMs != null &&
        child.createdAtMs != null &&
        child.createdAtMs < parent.createdAtMs
      ) {
        continue;
      }
      seen.add(child.pid);
      queue.push(child);
    }
  };
  enqueueChildren(rootPid);
  while (queue.length > 0) {
    const next = queue.shift()!;
    out.push(next);
    enqueueChildren(next.pid);
  }
  return out;
}

const run = (file: string, args: ReadonlyArray<string>, timeoutMs: number) =>
  new Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>(
    (resolve) => {
      execFile(
        file,
        [...args],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof error.code === "number" ? error.code : Number.NaN;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    },
  );

/** `pid ppid createdFileTimeUtc name` per line (Windows). */
const WINDOWS_SNAPSHOT_SCRIPT =
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | " +
  'ForEach-Object { $c = if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }; "$($_.ProcessId) $($_.ParentProcessId) $c $($_.Name)" }';

/** FILETIME (100 ns since 1601) to epoch ms. */
const fileTimeToEpochMs = (fileTime: number) => fileTime / 10_000 - 11_644_473_600_000;

export function parseWindowsSnapshot(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (match === null) continue;
    const created = Number(match[3]);
    out.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: match[4]!.trim(),
      createdAtMs: created > 0 ? fileTimeToEpochMs(created) : null,
    });
  }
  return out;
}

export function parsePosixSnapshot(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (match === null) continue;
    out.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: match[3]!.trim(),
      createdAtMs: null,
    });
  }
  return out;
}

const snapshotProcesses = Effect.promise(async (): Promise<ProcessEntry[] | null> => {
  if (process.platform === "win32") {
    const result = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT_SCRIPT],
      30_000,
    );
    return result.code === 0 ? parseWindowsSnapshot(result.stdout) : null;
  }
  const result = await run("ps", ["-A", "-o", "pid=,ppid=,comm="], 15_000);
  return result.code === 0 ? parsePosixSnapshot(result.stdout) : null;
});

const killOne = (pid: number) =>
  Effect.promise(async (): Promise<boolean> => {
    if (process.platform === "win32") {
      // By PID, without /T: the tree was already walked with the reuse guard.
      const result = await run("taskkill.exe", ["/PID", String(pid), "/F"], 15_000);
      return result.code === 0;
    }
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  });

export interface TerminatedDescendants {
  readonly rootPid: number;
  /** Descendants found under the root, parents first. */
  readonly found: ReadonlyArray<{ readonly pid: number; readonly name: string }>;
  /** PIDs the kill reported ended. A process that exited first is not an error. */
  readonly killed: ReadonlyArray<number>;
  /** Null when the process list could not be read (nothing was killed). */
  readonly snapshotFailed: boolean;
}

/**
 * Ends every descendant of `rootPid` (not the root: the caller closes it its
 * own way, so the provider can flush its transcript). Parents go first so a
 * shell cannot start a replacement for a child just killed.
 */
export const terminateDescendants = (rootPid: number): Effect.Effect<TerminatedDescendants> =>
  Effect.gen(function* () {
    if (!Number.isInteger(rootPid) || rootPid <= 4 || rootPid === process.pid) {
      return { rootPid, found: [], killed: [], snapshotFailed: false };
    }
    const snapshot = yield* snapshotProcesses;
    if (snapshot === null) return { rootPid, found: [], killed: [], snapshotFailed: true };
    const found = descendantsOf(snapshot, rootPid);
    const killed: number[] = [];
    for (const entry of found) {
      if (yield* killOne(entry.pid)) killed.push(entry.pid);
    }
    return {
      rootPid,
      found: found.map((entry) => ({ pid: entry.pid, name: entry.name })),
      killed,
      snapshotFailed: false,
    };
  });
