import * as NodeOS from "node:os";

import { assert, describe, it } from "@effect/vitest";

import type { ProcessEntry } from "../../provider/processTree.ts";
import { BOT_PROCESS_PRIORITY_ENV } from "../../provider/botProcessPriority.ts";
import { keepBrowserPriorityNormal, ourBrowserProcesses } from "./browserPriority.ts";

const SERVER = 100;
const entry = (pid: number, parentPid: number, name: string): ProcessEntry => ({
  pid,
  parentPid,
  name,
  createdAtMs: 1_000 + pid,
});

// server 100 -> chrome 200 (browser) -> chrome 201 (gpu), 202 (renderer)
// server 100 -> claude 300 -> chrome 400 (a bot's own test Chrome)
// server 100 -> node 500
const snapshot: ProcessEntry[] = [
  entry(SERVER, 1, "node.exe"),
  entry(200, SERVER, "chrome.exe"),
  entry(201, 200, "chrome.exe"),
  entry(202, 200, "chrome.exe"),
  entry(300, SERVER, "claude.exe"),
  entry(400, 300, "chrome.exe"),
  entry(500, SERVER, "node.exe"),
];

const BELOW_NORMAL = NodeOS.constants.priority.PRIORITY_BELOW_NORMAL;
const NORMAL = NodeOS.constants.priority.PRIORITY_NORMAL;

const harness = (priorities: Record<number, number>) => {
  const sets: Array<{ pid: number; priority: number }> = [];
  return {
    sets,
    deps: {
      env: {},
      platform: "win32" as const,
      serverPid: SERVER,
      listProcesses: async () => snapshot,
      getPriority: (pid: number) => {
        const value = priorities[pid];
        if (value === undefined) throw new Error("no access");
        return value;
      },
      setPriority: (pid: number, priority: number) => {
        sets.push({ pid, priority });
        priorities[pid] = priority;
      },
    },
  };
};

describe("ourBrowserProcesses", () => {
  it("takes the server's own Chrome tree and not a Chrome a bot started", () => {
    assert.deepEqual(
      ourBrowserProcesses(snapshot, SERVER).map((p) => p.pid),
      [200, 201, 202],
    );
  });

  it("also takes a configured executable that is not named chrome", () => {
    const withEdge = [...snapshot, entry(600, SERVER, "brave.exe"), entry(601, 600, "brave.exe")];
    assert.deepEqual(
      ourBrowserProcesses(withEdge, SERVER, "C:\\Apps\\Brave\\brave.exe").map((p) => p.pid),
      [200, 201, 202, 600, 601],
    );
  });
});

describe("keepBrowserPriorityNormal", () => {
  it("raises a BelowNormal Chrome tree to Normal and leaves bot processes alone", async () => {
    const { deps, sets } = harness({
      200: BELOW_NORMAL,
      201: BELOW_NORMAL,
      202: 19,
      400: BELOW_NORMAL,
    });
    const result = await keepBrowserPriorityNormal(undefined, deps);
    assert.deepEqual(result.raised, [200, 201, 202]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(sets, [
      { pid: 200, priority: NORMAL },
      { pid: 201, priority: NORMAL },
      { pid: 202, priority: NORMAL },
    ]);
  });

  it("leaves Normal and higher alone", async () => {
    const { deps, sets } = harness({ 200: NORMAL, 201: -7, 202: NORMAL });
    const result = await keepBrowserPriorityNormal(undefined, deps);
    assert.deepEqual(result, { checked: 3, raised: [], failed: [] });
    assert.deepEqual(sets, []);
  });

  it("keeps going when one process cannot be read", async () => {
    const { deps } = harness({ 200: BELOW_NORMAL, 202: BELOW_NORMAL });
    const result = await keepBrowserPriorityNormal(undefined, deps);
    assert.deepEqual(result.raised, [200, 202]);
    assert.deepEqual(result.failed, [201]);
  });

  it("does nothing with the kill switch", async () => {
    const { deps, sets } = harness({ 200: BELOW_NORMAL });
    const result = await keepBrowserPriorityNormal(undefined, {
      ...deps,
      env: { [BOT_PROCESS_PRIORITY_ENV]: "normal" },
    });
    assert.strictEqual(result.skipped, "disabled");
    assert.deepEqual(sets, []);
  });

  it("does nothing off Windows or when the process list is unavailable", async () => {
    const { deps } = harness({ 200: BELOW_NORMAL });
    assert.strictEqual(
      (await keepBrowserPriorityNormal(undefined, { ...deps, platform: "linux" })).skipped,
      "unsupported-platform",
    );
    assert.strictEqual(
      (await keepBrowserPriorityNormal(undefined, { ...deps, listProcesses: async () => null }))
        .skipped,
      "no-process-list",
    );
  });
});
