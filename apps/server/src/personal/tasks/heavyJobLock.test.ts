// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - the real-holder test spawns flock and polls /proc with plain Node timers, outside any Effect runtime.
import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  heavyJobLockHeld,
  lockHeldInProcLocks,
  mountDeviceFor,
  taskConcurrencyLimit,
} from "./heavyJobLock.ts";

// Real /proc/locks shape: `id type scope mode pid major:minor:inode start end`.
const PROC_LOCKS = [
  "1: POSIX  ADVISORY  READ  5483 00:24:2550570 128 128",
  "2: FLOCK  ADVISORY  WRITE 4349 00:39:2874988 0 EOF",
  "3: FLOCK  ADVISORY  WRITE 4349 00:51:2874988 0 EOF",
  "4: FLOCK  ADVISORY  READ  4349 00:39:2874988 0 EOF",
  "",
].join("\n");

// This machine, 26 Oct 2026: /home is the btrfs subvolume `root/@home` on
// /dev/mapper/root. mountinfo says 0:36 (decimal) while statSync says 57 (hex
// 00:39); /proc/locks prints 00:24, which is 0:36. /tmp is tmpfs 0:38.
const MOUNTINFO = [
  "22 1 0:38 / /tmp rw,nosuid,nodev shared:12 - tmpfs tmpfs rw",
  "44 1 8:1 / / rw,relatime shared:1 - btrfs /dev/mapper/root rw,compress=zstd:3",
  "59 44 0:36 /@home /home rw,relatime shared:196 - btrfs /dev/mapper/root rw,compress=zstd:3",
  "",
].join("\n");

describe("heavy job lock probe", () => {
  it("sees a held write flock on the lock file's own device and inode", () => {
    expect(lockHeldInProcLocks(PROC_LOCKS, { major: 0, minor: 0x39, inode: 2874988 })).toBe(true);
  });

  it("recognises a shared flock and ignores unrelated locks", () => {
    expect(lockHeldInProcLocks(PROC_LOCKS, { major: 0, minor: 0x24, inode: 2874988 })).toBe(false);
    expect(lockHeldInProcLocks(PROC_LOCKS, { major: 0, minor: 0x39, inode: 999 })).toBe(false);
    expect(
      lockHeldInProcLocks("1: FLOCK  ADVISORY  READ  4349 00:39:2874988 0 EOF\n", {
        major: 0,
        minor: 0x39,
        inode: 2874988,
      }),
    ).toBe(true);
    expect(lockHeldInProcLocks("", { major: 0, minor: 0x39, inode: 1 })).toBe(false);
  });

  it("takes the device from the deepest mount that contains the path", () => {
    expect(mountDeviceFor("/home/harout/.personal-bots/run/omarchy-heavy.lock", MOUNTINFO)).toEqual(
      {
        major: 0,
        minor: 36,
      },
    );
    // Same filesystem as /home, so the same device.
    expect(mountDeviceFor("/home", MOUNTINFO)).toEqual({ major: 0, minor: 36 });
    // Not a prefix of /home, and not under it.
    expect(mountDeviceFor("/tmp/x.lock", MOUNTINFO)).toEqual({ major: 0, minor: 38 });
    expect(mountDeviceFor("/etc/hosts", MOUNTINFO)).toEqual({ major: 8, minor: 1 });
    expect(mountDeviceFor("/homepage/lock", MOUNTINFO)).toEqual({ major: 8, minor: 1 });
    expect(mountDeviceFor("/nowhere/lock", "")).toBeNull();
  });

  it("decodes mountinfo's escaped mount points", () => {
    const escaped = "7 1 0:44 / /home/with\\040space rw - btrfs /dev/x rw";
    expect(mountDeviceFor("/home/with space/lock", escaped)).toEqual({ major: 0, minor: 44 });
  });

  it("answers not held off Linux or when the lock file is missing", () => {
    expect(heavyJobLockHeld({ platform: "win32" })).toBe(false);
    expect(
      heavyJobLockHeld({
        platform: "linux",
        lockPath: "/nonexistent/lock",
        stat: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBe(false);
  });

  it("matches a held flock through the mount device, not stat's device", () => {
    // The old bug: stat's dev (0x39) was the target, so a flock printed by
    // /proc/locks under the mount's 00:24 never matched.
    expect(
      heavyJobLockHeld({
        platform: "linux",
        lockPath: "/home/harout/.personal-bots/run/omarchy-heavy.lock",
        realpath: (path) => path,
        stat: () => ({ ino: 2874988 }),
        readFile: (path) =>
          path === "/proc/locks"
            ? "2: FLOCK  ADVISORY  WRITE 4349 00:24:2874988 0 EOF\n"
            : MOUNTINFO,
      }),
    ).toBe(true);
    expect(
      heavyJobLockHeld({
        platform: "linux",
        lockPath: "/home/harout/.personal-bots/run/omarchy-heavy.lock",
        realpath: (path) => path,
        stat: () => ({ ino: 2874988 }),
        readFile: (path) => (path === "/proc/locks" ? PROC_LOCKS : MOUNTINFO),
      }),
    ).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "sees a real shared flock held by another process on this machine's home filesystem",
    async () => {
      // /tmp is tmpfs, where stat's device happens to agree with /proc/locks;
      // the bug only shows on the mount the app's lock really lives on.
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.homedir(), ".hbots-lock-probe-"));
      const lockFile = NodePath.join(dir, "probe.lock");
      NodeFS.writeFileSync(lockFile, "");
      const holder = spawn("flock", ["-s", "-n", lockFile, "sleep", "20"], { stdio: "ignore" });
      const waitFor = async (want: boolean): Promise<boolean> => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (heavyJobLockHeld({ lockPath: lockFile }) === want) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return heavyJobLockHeld({ lockPath: lockFile }) === want;
      };
      try {
        expect(await waitFor(true)).toBe(true);
      } finally {
        // Captured PID only; the child is ours.
        if (holder.exitCode === null && holder.signalCode === null) {
          holder.kill();
          await new Promise((resolve) => holder.once("exit", resolve));
        }
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
      // The file is gone with the directory, so a missing lock is "not held".
      expect(heavyJobLockHeld({ lockPath: lockFile })).toBe(false);
    },
    20_000,
  );
});

describe("task concurrency limit", () => {
  it("is 5 while a heavy job holds the lock and 8 otherwise", () => {
    expect(taskConcurrencyLimit(5, 8, () => true)).toBe(5);
    expect(taskConcurrencyLimit(5, 8, () => false)).toBe(8);
  });
});
