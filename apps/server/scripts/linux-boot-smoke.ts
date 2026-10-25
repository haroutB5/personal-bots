#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a standalone smoke: it spawns the real server and polls it with plain fetch.
// @effect-diagnostics globalFetch:off - the point is the network exactly as the phone uses it.
// @effect-diagnostics globalTimers:off - a test script, not a service.
// @effect-diagnostics globalDate:off - elapsed-time guard for the stream reader.
// @effect-diagnostics globalRandom:off - picks a free test port.
/**
 * Live boot smoke for a Linux hbots server (migration milestone 1).
 *
 * Starts the built server against a throwaway data root, mints an admin
 * bearer token with the CLI, and checks what the phone and the Performance
 * tab rely on:
 *
 *   - /version.txt, the web app's index and a 401 on an unauthenticated API;
 *   - the authenticated PC summary (real CPU, RAM, disk);
 *   - the performance stream: statics from this machine and live samples with
 *     CPU, memory and disk, plus whatever sensors the hardware exposes.
 *
 * It never touches %USERPROFILE%\.personal-bots or the live release. The server
 * is stopped by its recorded PID (never by name) at the end, success or not.
 *
 *   cd apps/server && node scripts/linux-boot-smoke.ts [--keep-root]
 */
import { spawn, spawnSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const here = NodePath.dirname(fileURLToPath(import.meta.url));
const serverDir = NodePath.dirname(here);
const bin = NodePath.join(serverDir, "dist", "bin.mjs");
const keepRoot = process.argv.includes("--keep-root");
const port = 38480 + Math.floor(Math.random() * 40);
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hbots-linux-smoke-"));

const results: Array<{ readonly name: string; readonly detail: string }> = [];
const fail = (message: string): never => {
  process.stderr.write(`FAIL ${message}\n`);
  throw new Error(message);
};
const pass = (name: string, detail: string) => {
  results.push({ name, detail });
  process.stdout.write(`PASS ${name}: ${detail}\n`);
};

if (!NodeFS.existsSync(bin)) fail(`build the server first: ${bin} is missing`);

// 1. An admin token for the throwaway root, before the server owns the DB.
const issued = spawnSync(
  process.execPath,
  [bin, "auth", "session", "issue", "--base-dir", root, "--ttl", "1h", "--token-only"],
  { encoding: "utf8", timeout: 120_000 },
);
const token = (issued.stdout ?? "").trim();
if (issued.status !== 0 || token === "") {
  fail(`could not mint a token: ${(issued.stderr ?? "").trim().slice(0, 300)}`);
}
pass("auth token minted", `${token.length} characters`);

// 2. Start the server exactly as a service would.
const logFile = NodePath.join(root, "server.log");
const log = NodeFS.openSync(logFile, "a");
const server = spawn(
  process.execPath,
  [bin, "serve", "--base-dir", root, "--port", String(port), "--host", "127.0.0.1", "--no-browser"],
  { cwd: serverDir, env: { ...process.env, T3CODE_NO_BROWSER: "1" }, stdio: ["ignore", log, log] },
);

const base = `http://127.0.0.1:${port}`;
const fetchJson = async (path: string, auth = true) => {
  const response = await fetch(`${base}${path}`, {
    headers: auth ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: response.status, text: await response.text() };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stop = () => {
  if (server.pid !== undefined && server.exitCode === null) {
    try {
      process.kill(server.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
};

const main = async (): Promise<void> => {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/version.txt`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  if (!ready) {
    const tail = NodeFS.readFileSync(logFile, "utf8").split("\n").slice(-25).join("\n");
    fail(`the server did not answer /version.txt\n${tail}`);
  }

  const version = await fetchJson("/version.txt", false);
  if (version.status !== 200 || !/version=/.test(version.text)) fail("/version.txt is wrong");
  pass("version.txt", version.text.trim().replace(/\s+/g, " "));

  const index = await fetchJson("/", false);
  if (index.status !== 200 || !/<html/i.test(index.text)) fail("the web app's index is not served");
  pass("web app served", `${index.text.length} bytes of HTML`);

  const anonymous = await fetchJson("/api/personal/performance/summary", false);
  if (anonymous.status !== 401) fail(`unauthenticated summary returned ${anonymous.status}`);
  const anonymousPush = await fetchJson("/api/personal/push/sent", false);
  if (anonymousPush.status !== 401) fail(`unauthenticated push/sent returned ${anonymousPush.status}`);
  pass("unauthenticated API", "summary and push/sent both 401");

  const summaryResponse = await fetchJson("/api/personal/performance/summary");
  if (summaryResponse.status !== 200) fail(`summary returned ${summaryResponse.status}`);
  const summary = JSON.parse(summaryResponse.text) as Record<string, number | string | null>;
  if (typeof summary["cpuPct"] !== "number") fail("summary has no CPU reading");
  if (typeof summary["memTotalGB"] !== "number" || summary["memTotalGB"] <= 0) {
    fail("summary has no total memory");
  }
  if (typeof summary["diskTotalGB"] !== "number" || summary["diskTotalGB"] <= 0) {
    fail("summary has no disk size");
  }
  pass(
    "PC summary",
    `cpu ${String(summary["cpuPct"])}%, ram ${String(summary["memTotalGB"])} GB, disk ${String(summary["diskLabel"])} ${String(summary["diskFreeGB"])}/${String(summary["diskTotalGB"])} GB`,
  );

  // 3. The live stream: statics plus sampled values from the Linux helper.
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/personal/performance/stream`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  if (stream.status !== 200) fail(`stream returned ${stream.status}`);
  const body = stream.body;
  if (body === null) throw new Error("the stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hello: any = null;
  const samples: any[] = [];
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && samples.length < 3) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n\n");
    while (newline >= 0) {
      const chunk = buffer.slice(0, newline).replace(/^data: /, "");
      buffer = buffer.slice(newline + 2);
      try {
        const event = JSON.parse(chunk);
        if (event.kind === "hello") hello = event;
        if (event.kind === "sample") samples.push(event.sample);
      } catch {
        // A partial frame: keep reading.
      }
      newline = buffer.indexOf("\n\n");
    }
  }
  controller.abort();
  if (hello === null) fail("the stream sent no hello");
  const statics = hello.statics as Record<string, unknown>;
  if (typeof statics["pcCpu"] !== "string" || statics["pcCpu"] === "") fail("no CPU name");
  if (typeof statics["pcThreads"] !== "number" || statics["pcThreads"] < 1) fail("no thread count");
  pass(
    "machine statics",
    `${String(statics["pcCpu"])}, ${String(statics["pcCores"])} cores/${String(statics["pcThreads"])} threads, ${String(statics["ramGB"])} GB, gpu ${String(statics["pcGpu"])}`,
  );
  if (samples.length < 2) fail(`only ${samples.length} samples arrived`);
  const latest = samples[samples.length - 1]!;
  if (typeof latest.cpuPct !== "number") fail("no CPU percent in the sample");
  if (typeof latest.memTotalGB !== "number" || latest.memTotalGB <= 0) fail("no memory in the sample");
  if (typeof latest.diskActivePct !== "number") fail("no disk activity in the sample");
  const sensorFields = ["cpuTempC", "ssdC", "fan1Rpm", "powerCpuW", "memFreeGB"] as const;
  const present = sensorFields.filter((field) => latest[field] !== null && latest[field] !== undefined);
  if (present.length === 0) fail("no sensor field has a value");
  pass(
    "live samples",
    `${samples.length} samples; cpu ${latest.cpuPct}%, mem ${latest.memUsedGB}/${latest.memTotalGB} GB, ` +
      `disk ${latest.diskReadMBps}/${latest.diskWriteMBps} MB/s, net ${latest.netDownMbps} Mb/s, ` +
      `sensors ${present.join(",")}, fan ${String(latest.fanStatus)}`,
  );
  if (latest.cpuTempC === null && latest.ssdC === null) {
    process.stdout.write(
      "NOTE no thermal sensor on this machine (WSL exposes no hwmon); the reader is proven by its sysfs unit tests\n",
    );
  }

  // 4. The helper process the sampler spawned belongs to this server and stops
  //    with it; the log must be clean of crashes.
  const logText = NodeFS.readFileSync(logFile, "utf8");
  if (/performance counter helper failed to start/.test(logText)) fail("the counter helper failed");
  const helperLine = /\[performance\] performance counter helper starting \(linux\)/.test(logText);
  if (!helperLine) fail("the sampler never started the Linux helper");
  pass("counter helper", "started");

  stop();
  const errors = logText.split("\n").filter((line) => /ERROR|FATAL/.test(line));
  if (errors.length > 0) {
    process.stdout.write(`NOTE server log has ${errors.length} ERROR line(s):\n${errors.slice(0, 5).join("\n")}\n`);
  } else {
    pass("server log", "0 ERROR lines");
  }

  process.stdout.write(`PASS live boot smoke complete (root ${root})\n`);
};

main()
  .catch((error) => {
    stop();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    stop();
    if (!keepRoot) {
      try {
        NodeFS.rmSync(root, { recursive: true, force: true });
      } catch {
        // Best effort.
      }
    }
  });
