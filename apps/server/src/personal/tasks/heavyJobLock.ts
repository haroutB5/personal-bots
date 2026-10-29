// @effect-diagnostics nodeBuiltinImport:off - the lock is a file on this machine; there is no Effect API for another process's flock.
/**
 * Whether a heavy job (a build, a full typecheck, an e2e run) holds the shared
 * machine lock right now.
 *
 * The team runs heavy commands through `dev-team/tools/heavy-job.sh`, which
 * takes a `flock` on
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
 * The device in `/proc/locks` is the mount's, not `statSync(path).dev`: /home
 * here is a btrfs subvolume whose stat device (57, hex 00:39) never matches the
 * mount device (0:36, hex 00:24) that every flock on it is reported under. It
 * therefore comes from `/proc/self/mountinfo`, for the mount that contains the
 * lock, and only the inode comes from stat.
 *
 * @module personal/tasks/heavyJobLock
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const HEAVY_JOB_LOCK_PATH = "/home/harout/.personal-bots/run/omarchy-heavy.lock";

export interface MountDevice {
  readonly major: number;
  readonly minor: number;
}

/** mountinfo escapes space, tab, newline and backslash as \040, \011, \012, \134. */
const unescapeMountPoint = (value: string): string =>
  value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

/**
 * The device `/proc/locks` reports for a path, from `/proc/self/mountinfo`:
 * the `major:minor` (decimal there) of the deepest mount that contains it.
 * This is the mount's superblock device, which is exactly what locks prints;
 * `statSync(path).dev` is a different number on a btrfs subvolume.
 */
export function mountDeviceFor(path: string, mountInfo: string): MountDevice | null {
  let best: { readonly mountPoint: string; readonly device: MountDevice } | null = null;
  for (const line of mountInfo.split("\n")) {
    // id parent major:minor root mount-point options [optional fields] - fs source super-options
    const fields = line.trim().split(" ");
    if (fields.length < 6) continue;
    const [majorText, minorText] = (fields[2] ?? "").split(":");
    if (!majorText || !minorText) continue;
    if (!/^\d+$/.test(majorText) || !/^\d+$/.test(minorText)) continue;
    const mountPoint = unescapeMountPoint(fields[4] ?? "");
    if (!mountPoint.startsWith("/")) continue;
    const contains =
      mountPoint === "/"
        ? path.startsWith("/")
        : path === mountPoint || path.startsWith(`${mountPoint}/`);
    if (!contains) continue;
    if (best === null || mountPoint.length > best.mountPoint.length) {
      best = { mountPoint, device: { major: Number(majorText), minor: Number(minorText) } };
    }
  }
  return best?.device ?? null;
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
    if (mode !== "WRITE" && mode !== "READ") continue;
    if (pid === undefined || !/^\d+$/.test(pid) || Number(pid) <= 0) continue;
    const [major, minor, inode] = (id ?? "").split(":");
    if (major === majorHex && minor === minorHex && inode === String(target.inode)) return true;
  }
  return false;
}

export interface HeavyJobProbeDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly lockPath?: string;
  readonly readFile?: (path: string) => string;
  readonly stat?: (path: string) => { readonly ino: number };
  /** Resolves symlinks in the lock path before it is matched to a mount. */
  readonly realpath?: (path: string) => string;
}

/**
 * Tests only: `held`/`free` force the answer so a suite that depends on the
 * five-slot cap is deterministic on a machine where no heavy job runs. Read on
 * every probe, so no restart applies it.
 */
export const HEAVY_JOB_PROBE_ENV = "PERSONAL_TASKS_HEAVY_PROBE";

/** Read-only: true while a heavy job holds the shared lock. */
export function heavyJobLockHeld(deps: HeavyJobProbeDeps = {}): boolean {
  const forced = (deps.env ?? process.env)[HEAVY_JOB_PROBE_ENV]?.trim().toLowerCase();
  if (forced === "held") return true;
  if (forced === "free") return false;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform decides whether /proc exists; tests inject it.
  const platform = deps.platform ?? NodeOS.platform();
  if (platform !== "linux") return false;
  const lockPath = deps.lockPath ?? HEAVY_JOB_LOCK_PATH;
  const readFile = deps.readFile ?? ((path: string) => NodeFS.readFileSync(path, "utf8"));
  try {
    const stat = (deps.stat ?? ((path: string) => NodeFS.statSync(path)))(lockPath);
    const realPath = (deps.realpath ?? ((path: string) => NodeFS.realpathSync(path)))(lockPath);
    const device = mountDeviceFor(realPath, readFile("/proc/self/mountinfo"));
    // No mount means the device is unknown; answer "not held" as before rather
    // than guess at a device that would never match.
    if (device === null) return false;
    return lockHeldInProcLocks(readFile("/proc/locks"), { ...device, inode: stat.ino });
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
