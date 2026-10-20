// Run under heavy-job.ps1, against a disposable server only. Each priority
// adjustment targets the server PID supplied by throwaway-server.ps1.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
const [origin, serverPid, root, out] = process.argv.slice(2);
if (
  !origin?.startsWith("http://127.0.0.1:") ||
  !/^\d+$/.test(serverPid) ||
  !path.basename(root).startsWith("hbots-tw-")
)
  throw new Error("Disposable server required");
const helper = path
  .resolve(import.meta.dirname, "../background-priority.ps1")
  .replaceAll("'", "''");
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)] ?? 0;
const rounds = [];
const load = new Worker(new URL("./memory-pressure.mjs", import.meta.url));
try {
  const pressure = await new Promise((resolve, reject) => {
    load.once("message", resolve);
    load.once("error", reject);
  });
  console.log("pressure", JSON.stringify(pressure));
  for (const mode of ["old", "new", "new", "old", "old", "new"]) {
    const io = mode === "old" ? 1 : 2,
      mem = mode === "old" ? 2 : 5;
    const priority = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `. '${helper}'; Set-PbProcessPriority -ProcessId ${serverPid} -Cpu AboveNormal -Io ${io} -Memory ${mem}; Get-PbProcessPriorityText -ProcessId ${serverPid}`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    if (!priority.endsWith(`cpu=AboveNormal io=${io} mem=${mem}`)) throw new Error(priority);
    const logFile = path.join(root, "server.log");
    const logOffset = fs.readFileSync(logFile, "utf8").length;
    const from = Date.now(),
      latencies = [],
      free = [],
      errors = [];
    while (Date.now() - from < 10_000) {
      const t = performance.now();
      try {
        const res = await fetch(origin + "/api/auth/session", {
          signal: AbortSignal.timeout(15_000),
        });
        await res.arrayBuffer();
        if (res.status !== 200) errors.push(res.status);
      } catch (e) {
        errors.push(String(e));
      }
      latencies.push(performance.now() - t);
      free.push(os.freemem() / 1024 ** 2);
      await new Promise((r) => setTimeout(r, 100));
    }
    const log = fs.readFileSync(logFile, "utf8").slice(logOffset);
    const stalls = [...log.matchAll(/event loop stall captured\s*\{([^}]*)\}/g)]
      .map((m) => Number(/durationMs:\s*(\d+(?:\.\d+)?)/.exec(m[1])?.[1]))
      .filter(Number.isFinite);
    const round = {
      mode,
      priority,
      startedAt: from,
      endedAt: Date.now(),
      n: latencies.length,
      latencyMedianMs: quantile(latencies, 0.5),
      latencyP75Ms: quantile(latencies, 0.75),
      latencyMaxMs: Math.max(...latencies),
      freeMinMb: Math.min(...free),
      freeMedianMb: quantile(free, 0.5),
      stallCount: stalls.length,
      stallMedianMs: quantile(stalls, 0.5),
      stallMaxMs: Math.max(0, ...stalls),
      errors,
      latencies,
    };
    rounds.push(round);
    console.log(JSON.stringify({ ...round, latencies: undefined }));
  }
  const report = {
    machine: { totalMb: os.totalmem() / 1024 ** 2, cpuCount: os.cpus().length },
    pressure,
    rounds,
  };
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
} finally {
  await load.terminate();
  // Leave this disposable server at the new priority for subsequent checks.
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `. '${helper}'; Set-PbProcessPriority -ProcessId ${serverPid} -Cpu AboveNormal -Io 2 -Memory 5`,
    ],
    { windowsHide: true },
  );
}
