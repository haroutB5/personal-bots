// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - runs the watchdog in a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";

import type { WatchdogStall } from "./StallWatchdog.ts";

/**
 * These run the real worker in a child process: a worker thread reads the main
 * thread's profile through the inspector, so the main thread has to be a process
 * of its own, not a test worker.
 */
const watchdogUrl = NodeURL.pathToFileURL(
  NodePath.join(import.meta.dirname, "StallWatchdog.ts"),
).href;

const HARNESS = `
const { startStallWatchdog, stallProfilerModeFromEnv } = await import(process.argv[2]);
const block = process.argv[4];
const got = [];
const watchdog = startStallWatchdog({
  profilerMode: stallProfilerModeFromEnv(process.argv[3]),
  thresholdMs: Number(process.argv[5]),
  onStall: (stall) => got.push(stall),
  onError: (message) => console.error("watchdog error", message),
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spinInJavaScript(ms) {
  const end = Date.now() + ms;
  let sum = 0;
  while (Date.now() < end) sum += Math.sqrt(sum + 1);
  return sum;
}
function readDevZero(ms) {
  const fs = globalThis.require("node:fs");
  const fd = fs.openSync("/dev/zero", "r");
  const buffer = Buffer.alloc(1 << 20);
  const end = Date.now() + ms;
  while (Date.now() < end) fs.readSync(fd, buffer, 0, buffer.length, null);
  fs.closeSync(fd);
}
function waitInNativeCode(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function runSlowQuery() {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("create table t(a); with recursive c(x) as (select 1 union all select x+1 from c limit 11000) insert into t select x from c;");
  return db.prepare("select count(*) from t a, t b where (a.a * b.a) % 7919 = 3").get();
}

await sleep(1500);
globalThis.require = (await import("node:module")).createRequire(import.meta.url);
const startedAt = Date.now();
if (block === "js") spinInJavaScript(2500);
else if (block === "js-1150") spinInJavaScript(1150);
else if (block === "dev-zero") readDevZero(2500);
else if (block === "native") waitInNativeCode(2500);
else if (block === "sqlite") runSlowQuery();
const blockedMs = Date.now() - startedAt;
await sleep(2500);
await watchdog.stop();
console.log(JSON.stringify({ blockedMs, stalls: got }));
`;

let dir: string;
let harnessPath: string;

beforeAll(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "stall-watchdog-"));
  harnessPath = NodePath.join(dir, "harness.mjs");
  await NodeFSP.writeFile(harnessPath, HARNESS, "utf8");
});

afterAll(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

const run = (mode: string, block: string, thresholdMs = 800) =>
  new Promise<{ blockedMs: number; stalls: ReadonlyArray<WatchdogStall> }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [harnessPath, watchdogUrl, mode, block, String(thresholdMs)],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, T3CODE_STALL_RECORDER: "on" },
        timeout: 60_000,
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("exit", (code, signal) => {
      if (code !== 0) reject(new Error(`harness exit ${code ?? signal}: ${err}`));
      else resolve(JSON.parse(out.trim().split("\n").pop()!));
    });
  });

describe("StallWatchdog", () => {
  it("names the JavaScript function that blocked the loop (continuous profiler)", async () => {
    const { stalls } = await run("continuous", "js");
    expect(stalls).toHaveLength(1);
    const [stall] = stalls;
    expect(stall!.durationMs).toBeGreaterThan(1800);
    expect(stall!.durationMs).toBeLessThan(4000);
    expect(stall!.summary!.topSelf[0]!.frame).toContain("spinInJavaScript");
    expect(stall!.cpuUserMs + stall!.cpuSystemMs).toBeGreaterThan(1500);
    expect(stall!.profilerError).toBeNull();
    if (HostProcess.Platform.defaultValue() === "linux") {
      expect(stall!.pressure.coveredMs).toBeGreaterThan(1000);
      expect(["running", "cpu", null]).toContain(stall!.pressure.cause);
    }
  });

  it("still profiles a stall when the profiler only starts once it is detected", async () => {
    // Functions that were already running are not named in this mode, which is why
    // it is not the default: the profile only says where the time went.
    const { stalls } = await run("detect", "js");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.summary!.windowMs).toBeGreaterThan(500);
    expect(stalls[0]!.profileStartLatencyMs).toBeLessThan(500);
  });

  it("names the caller of a blocking native call", async () => {
    const { stalls } = await run("continuous", "native");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.summary!.topSelf[0]!.frame).toContain("waitInNativeCode");
    if (HostProcess.Platform.defaultValue() === "linux") {
      const { pressure } = stalls[0]!;
      expect(pressure.windowMs).toBeGreaterThan(500);
      expect(pressure.mainUserMs).toBeLessThan(pressure.windowMs! / 4);
      expect(pressure.cause).toBe("blocked");
    }
  });

  it("does not call kernel time reclaim without a memory stall (Verifier 2, 3a)", async () => {
    const { stalls } = await run("continuous", "dev-zero");
    expect(stalls).toHaveLength(1);
    const { pressure } = stalls[0]!;
    if (HostProcess.Platform.defaultValue() === "linux") {
      expect(pressure.memorySomeMs).toBeLessThan(pressure.mainSystemMs! / 2);
      expect(["kernel", "cpu", null]).toContain(pressure.cause);
    }
  });

  it("never calls a short JavaScript spin blocked (Verifier 2, 3b)", async () => {
    const { blockedMs, stalls } = await run("continuous", "js-1150", 1000);
    expect(blockedMs).toBeGreaterThanOrEqual(1150);
    expect(stalls.length).toBeLessThanOrEqual(1);
    if (HostProcess.Platform.defaultValue() === "linux") {
      for (const stall of stalls) expect(["running", "cpu", null]).toContain(stall.pressure.cause);
    }
  });

  it("sees inside a long synchronous SQLite statement with the continuous profiler", async () => {
    const { blockedMs, stalls } = await run("continuous", "sqlite");
    expect(blockedMs).toBeGreaterThan(1500);
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    const frames = stalls.flatMap((stall) => stall.summary?.topSelf.map((f) => f.frame) ?? []);
    expect(frames.join("\n")).toContain("runSlowQuery");
  });

  it("reports nothing and exits cleanly when the loop is healthy", async () => {
    const { stalls } = await run("continuous", "none");
    expect(stalls).toEqual([]);
  });

  it("runs without a profiler when switched off", async () => {
    const { stalls } = await run("off", "js");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.summary).toBeNull();
    expect(stalls[0]!.durationMs).toBeGreaterThan(1800);
  });
});
