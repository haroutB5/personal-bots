import { describe, expect, it } from "vite-plus/test";

import {
  devMajorMinor,
  heavyJobLockHeld,
  lockHeldInProcLocks,
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

describe("heavy job lock probe", () => {
  it("sees a held write flock on the lock file's own device and inode", () => {
    expect(lockHeldInProcLocks(PROC_LOCKS, { major: 0, minor: 0x39, inode: 2874988 })).toBe(true);
  });

  it("ignores the same inode on another device, a read lock, and no entry", () => {
    expect(lockHeldInProcLocks(PROC_LOCKS, { major: 0, minor: 0x39, inode: 2874988 })).toBe(true);
    expect(lockHeldInProcLocks(PROC_LOCKS, { major: 0, minor: 0x24, inode: 2874988 })).toBe(false);
    expect(lockHeldInProcLocks(PROC_LOCKS, { major: 0, minor: 0x39, inode: 999 })).toBe(false);
    // Only the READ line matches these, so the lock is not held for a writer.
    expect(
      lockHeldInProcLocks("1: FLOCK  ADVISORY  READ  4349 00:39:2874988 0 EOF\n", {
        major: 0,
        minor: 0x39,
        inode: 2874988,
      }),
    ).toBe(false);
    expect(lockHeldInProcLocks("", { major: 0, minor: 0x39, inode: 1 })).toBe(false);
  });

  it("decodes glibc's dev_t the way /proc/locks prints it", () => {
    expect(devMajorMinor(0x39)).toEqual({ major: 0, minor: 0x39 });
    expect(devMajorMinor((253 << 8) | 4)).toEqual({ major: 253, minor: 4 });
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

  it("finds a held lock through an injected stat and /proc/locks", () => {
    expect(
      heavyJobLockHeld({
        platform: "linux",
        lockPath: "/lock",
        stat: () => ({ dev: 0x39, ino: 2874988 }),
        readFile: () => PROC_LOCKS,
      }),
    ).toBe(true);
  });
});

describe("task concurrency limit", () => {
  it("is 5 while a heavy job holds the lock and 8 otherwise", () => {
    expect(taskConcurrencyLimit(5, 8, () => true)).toBe(5);
    expect(taskConcurrencyLimit(5, 8, () => false)).toBe(8);
  });
});
