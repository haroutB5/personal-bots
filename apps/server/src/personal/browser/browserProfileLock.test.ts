import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { clearStaleProfileLock, detectProfileLock } from "./browserShared.ts";

const roots: string[] = [];

const profileDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-lock-"));
  roots.push(dir);
  return dir;
};

const singletonFiles = (dir: string) =>
  ["SingletonLock", "SingletonCookie", "SingletonSocket"].filter((name) => {
    try {
      // The lock is a symlink to a name that need not exist, so lstat, not existsSync.
      NodeFS.lstatSync(NodePath.join(dir, name));
      return true;
    } catch {
      return false;
    }
  });

afterEach(() => {
  for (const dir of roots.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
});

describe("browser profile lock", () => {
  it("is not locked on an empty profile", async () => {
    expect(await detectProfileLock(profileDir())).toEqual({
      locked: false,
      pid: null,
      stale: false,
    });
  });

  it("reports a live POSIX holder as locked, by pid", async () => {
    const dir = profileDir();
    NodeFS.symlinkSync("host-4242", NodePath.join(dir, "SingletonLock"));
    expect(await detectProfileLock(dir, { isAlive: () => true })).toEqual({
      locked: true,
      pid: 4242,
      stale: false,
    });
  });

  it("calls a lock left by an exited process stale instead of locked", async () => {
    const dir = profileDir();
    NodeFS.symlinkSync("omarchy-6552", NodePath.join(dir, "SingletonLock"));
    NodeFS.symlinkSync("123456", NodePath.join(dir, "SingletonCookie"));
    expect(await detectProfileLock(dir, { isAlive: () => false })).toEqual({
      locked: false,
      pid: 6552,
      stale: true,
    });
  });

  it("clears every singleton file of a stale lock, and only a stale one", async () => {
    const dir = profileDir();
    NodeFS.symlinkSync("omarchy-6552", NodePath.join(dir, "SingletonLock"));
    NodeFS.symlinkSync("123456", NodePath.join(dir, "SingletonCookie"));
    NodeFS.symlinkSync("/tmp/sock", NodePath.join(dir, "SingletonSocket"));
    expect(await clearStaleProfileLock(dir, { isAlive: () => false })).toBe(true);
    expect(singletonFiles(dir)).toEqual([]);

    // A lock naming a live process is never touched.
    const live = profileDir();
    NodeFS.symlinkSync(`host-${process.pid}`, NodePath.join(live, "SingletonLock"));
    expect(await clearStaleProfileLock(live, { isAlive: () => true })).toBe(false);
    expect(singletonFiles(live)).toEqual(["SingletonLock"]);
  });
});
