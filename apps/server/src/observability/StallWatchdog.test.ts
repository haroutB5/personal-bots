// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - runs the watchdog in a real child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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
  thresholdMs: 800,
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
const startedAt = Date.now();
if (block === "js") spinInJavaScript(2500);
else if (block === "native") waitInNativeCode(2500);
else if (block === "sqlite") { globalThis.require = (await import("node:module")).createRequire(import.meta.url); runSlowQuery(); }
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

const run = (mode: string, block: string) =>
  new Promise<{ blockedMs: number; stalls: ReadonlyArray<WatchdogStall> }>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [harnessPath, watchdogUrl, mode, block],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, T3CODE_STALL_RECORDER: "on" } },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`harness timed out: ${err}`));
    }, 60_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`harness exit ${code}: ${err}`));
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
  }, 70_000);

  it("still profiles a stall when the profiler only starts once it is detected", async () => {
    // Functions that were already running are not named in this mode, which is why
    // it is not the default: the profile only says where the time went.
    const { stalls } = await run("detect", "js");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.summary!.windowMs).toBeGreaterThan(500);
    expect(stalls[0]!.profileStartLatencyMs).toBeLessThan(500);
  }, 70_000);

  it("names the caller of a blocking native call", async () => {
    const { stalls } = await run("continuous", "native");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.summary!.topSelf[0]!.frame).toContain("waitInNativeCode");
  }, 70_000);

  it("sees inside a long synchronous SQLite statement with the continuous profiler", async () => {
    const { blockedMs, stalls } = await run("continuous", "sqlite");
    expect(blockedMs).toBeGreaterThan(1500);
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    const frames = stalls.flatMap((stall) => stall.summary?.topSelf.map((f) => f.frame) ?? []);
    expect(frames.join("\n")).toContain("runSlowQuery");
  }, 70_000);

  it("reports nothing and exits cleanly when the loop is healthy", async () => {
    const { stalls } = await run("continuous", "none");
    expect(stalls).toEqual([]);
  }, 70_000);

  it("runs without a profiler when switched off", async () => {
    const { stalls } = await run("off", "js");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]!.summary).toBeNull();
    expect(stalls[0]!.durationMs).toBeGreaterThan(1800);
  }, 70_000);
});
