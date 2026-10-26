// @effect-diagnostics nodeBuiltinImport:off - the lock is a file on this machine; there is no Effect API for another process's flock.
/**
 * Whether a heavy job (a build, a full typecheck, an e2e run) holds the shared
 * machine lock right now.
 *
 * The team runs heavy commands through `dev-team/tools/heavy-job.sh`, which
 * takes an exclusive `flock` on
 * `~/.personal-bots/run/omarchy-heavy.lock` for the whole job. While it is
 * held, the laptop has little RAM to spare, so task dispatches drop from the
 * normal 8 to 5.
 *
 * The probe is read-only on purpose: it never opens, takes, writes or unlinks
 * the lock (a second `flock -n` would either steal the lock for an instant or
 * perturb the holder). Linux publishes every held flock in `/proc/locks` with
 * its device, inode and pid, so the answer comes from there. Anything but a
 * Linux host with a readable lock file answers "not held", which keeps the
 * normal limit.
 *
 * @module personal/tasks/heavyJobLock
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const HEAVY_JOB_LOCK_PATH = "/home/harout/.personal-bots/run/omarchy-heavy.lock";

/** glibc's `dev_t` encoding, the one `/proc/locks` prints as `major:minor`. */
export function devMajorMinor(dev: number): { readonly major: number; readonly minor: number } {
  const major = ((dev >> 8) & 0xfff) | ((dev >> 32) & ~0xfff);
  const minor = (dev & 0xff) | ((dev >> 12) & ~0xff);
  return { major, minor };
}

/**
 * True when `/proc/locks` shows a held FLOCK on this device and inode. Pure so
 * the parsing is testable without a real holder; POSIX record locks are
 * ignored (heavy-job.sh uses flock).
 */
export function lockHeldInProcLocks(
  content: string,
  target: { readonly major: number; readonly minor: number; readonly inode: number },
): boolean {
  const majorHex = target.major.toString(16).padStart(2, "0");
  const minorHex = target.minor.toString(16).padStart(2, "0");
  for (const line of content.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // id type scope mode pid dev:inode start end
    if (fields.length < 6) continue;
    const [, type, , mode, pid, id] = fields;
    if (type !== "FLOCK") continue;
    if (mode !== "WRITE") continue;
    if (pid === undefined || !/^\d+$/.test(pid) || Number(pid) <= 0) continue;
    const [major, minor, inode] = (id ?? "").split(":");
    if (major === majorHex && minor === minorHex && inode === String(target.inode)) return true;
  }
  return false;
}

export interface HeavyJobProbeDeps {
  readonly platform?: NodeJS.Platform;
  readonly lockPath?: string;
  readonly readFile?: (path: string) => string;
  readonly stat?: (path: string) => { readonly dev: number; readonly ino: number };
}

/** Read-only: true while a heavy job holds the shared lock. */
export function heavyJobLockHeld(deps: HeavyJobProbeDeps = {}): boolean {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform decides whether /proc exists; tests inject it.
  const platform = deps.platform ?? NodeOS.platform();
  if (platform !== "linux") return false;
  const lockPath = deps.lockPath ?? HEAVY_JOB_LOCK_PATH;
  try {
    const stat = (deps.stat ?? ((path: string) => NodeFS.statSync(path)))(lockPath);
    const contents = (deps.readFile ?? ((path: string) => NodeFS.readFileSync(path, "utf8")))(
      "/proc/locks",
    );
    const { major, minor } = devMajorMinor(stat.dev);
    return lockHeldInProcLocks(contents, { major, minor, inode: stat.ino });
  } catch {
    return false;
  }
}

/** The task-dispatch limit: 5 while a heavy job runs, 8 otherwise. */
export function taskConcurrencyLimit(
  heavyLimit: number,
  normalLimit: number,
  probe: () => boolean = heavyJobLockHeld,
): number {
  return probe() ? heavyLimit : normalLimit;
}

/** The lock's directory is the shared run folder, used only to place the default path. */
export const heavyJobLockDir = NodePath.dirname(HEAVY_JOB_LOCK_PATH);
