// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  descendantsOf,
  listProcesses,
  parseWindowsSnapshot,
  type ProcessEntry,
  resolveWindowsPowerShell,
  resolveWindowsTaskkill,
  terminateDescendants,
} from "./processTree.ts";

const entry = (
  pid: number,
  parentPid: number,
  createdAtMs: number | null = 1_000 + pid,
): ProcessEntry => ({ pid, parentPid, name: `p${pid}`, createdAtMs });

describe("descendantsOf", () => {
  it("walks the whole tree under the root, parents first, root excluded", () => {
    const snapshot = [entry(10, 1), entry(20, 10), entry(21, 10), entry(30, 20), entry(99, 1)];
    assert.deepEqual(
      descendantsOf(snapshot, 10, []).map((process) => process.pid),
      [20, 21, 30],
    );
  });

  it("skips a stranger naming a reused PID as its parent", () => {
    // 40 was created before 10 existed: its real parent was an older
    // process that also had PID 10.
    const snapshot = [entry(10, 1, 5_000), entry(40, 10, 4_000), entry(41, 10, 6_000)];
    assert.deepEqual(
      descendantsOf(snapshot, 10, []).map((process) => process.pid),
      [41],
    );
  });

  it("never returns this server or its parent, and survives a cycle", () => {
    const snapshot = [
      entry(10, 1),
      entry(process.pid, 10),
      entry(50, 10),
      entry(51, 50),
      { ...entry(50, 51) },
    ];
    const pids = descendantsOf(snapshot, 10).map((process) => process.pid);
    assert.isFalse(pids.includes(process.pid));
    assert.deepEqual(pids, [50, 51]);
  });

  it("reads the Windows process list", () => {
    const text = "4 0 0 System\r\n1234 900 134036544000000000 node.exe\r\nbad line\r\n";
    const parsed = parseWindowsSnapshot(text);
    assert.deepEqual(
      parsed.map((process) => [process.pid, process.parentPid, process.name]),
      [
        [4, 0, "System"],
        [1234, 900, "node.exe"],
      ],
    );
    assert.equal(parsed[0]?.createdAtMs, null);
    assert.isNumber(parsed[1]?.createdAtMs);
  });
});

const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_ENV = { SystemRoot: String.raw`C:\Windows` } as NodeJS.ProcessEnv;

describe("Windows system tool paths", () => {
  it("resolves powershell.exe under %SystemRoot%\\System32 when it exists", () => {
    assert.equal(
      resolveWindowsPowerShell({ env: WINDOWS_ENV, exists: (path) => path === POWERSHELL }),
      POWERSHELL,
    );
  });

  it("follows windir without SystemRoot, and falls back to the bare name when the file is absent", () => {
    const seen: string[] = [];
    assert.equal(
      resolveWindowsPowerShell({
        env: { windir: String.raw`D:\Win` } as NodeJS.ProcessEnv,
        exists: (path) => {
          seen.push(path);
          return false;
        },
      }),
      "powershell.exe",
    );
    assert.deepEqual(seen, [String.raw`D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`]);
    assert.equal(
      resolveWindowsPowerShell({ env: WINDOWS_ENV, exists: () => false }),
      "powershell.exe",
    );
  });

  it("resolves taskkill.exe the same way", () => {
    assert.equal(
      resolveWindowsTaskkill({ env: WINDOWS_ENV, exists: () => true }),
      String.raw`C:\Windows\System32\taskkill.exe`,
    );
    assert.equal(resolveWindowsTaskkill({ env: WINDOWS_ENV, exists: () => false }), "taskkill.exe");
  });
});

describe("listProcesses", () => {
  const output = "1234 900 134036544000000000 node.exe\r\n";

  it("runs the resolved powershell path on Windows and parses its list", async () => {
    const calls: string[] = [];
    const list = await listProcesses({
      platform: "win32",
      env: WINDOWS_ENV,
      exists: (path) => path === POWERSHELL,
      run: async (file) => {
        calls.push(file);
        return { code: 0, stdout: output, stderr: "" };
      },
    });
    assert.deepEqual(calls, [POWERSHELL]);
    assert.deepEqual(
      list?.map((entry) => entry.pid),
      [1234],
    );
  });

  it("falls back to the bare powershell.exe name when System32's is missing", async () => {
    const calls: string[] = [];
    await listProcesses({
      platform: "win32",
      env: WINDOWS_ENV,
      exists: () => false,
      run: async (file) => {
        calls.push(file);
        return { code: 1, stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(calls, ["powershell.exe"]);
  });

  it("returns null when the list could not be read", async () => {
    assert.isNull(
      await listProcesses({
        platform: "win32",
        env: WINDOWS_ENV,
        exists: () => true,
        run: async () => ({ code: Number.NaN, stdout: "", stderr: "" }),
      }),
    );
  });
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("terminateDescendants", () => {
  it.effect(
    "ends a sleeping grandchild by the parent's PID and leaves the parent to its owner",
    () =>
      Effect.gen(function* () {
        // The parent stands in for a provider CLI; its child is the bot's
        // `sleep`, which prints its PID and waits.
        const parent = NodeChildProcess.spawn(
          process.execPath,
          [
            "-e",
            `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" }); console.log(c.pid); setTimeout(() => {}, 120000);`,
          ],
          { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
        );
        const childPid = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              parent.stdout.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim())));
            }),
        );
        try {
          assert.isTrue(isAlive(childPid));
          const ended = yield* terminateDescendants(parent.pid!);
          assert.isFalse(ended.snapshotFailed);
          // Windows may add the child's console host (conhost.exe): also ours.
          assert.include(ended.killed, childPid);
          const found = ended.found.map((process) => process.pid);
          for (const pid of ended.killed) assert.include(found, pid);
          yield* Effect.promise(() => NodeTimersPromises.setTimeout(500));
          assert.isFalse(isAlive(childPid));
          assert.isTrue(isAlive(parent.pid!));
        } finally {
          parent.kill();
          if (isAlive(childPid)) process.kill(childPid);
        }
      }),
    60_000,
  );
});
