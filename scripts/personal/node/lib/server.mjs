// Server lifecycle: start, foreground supervisor (systemd), stop, restart,
// status. Identity checks mirror the PowerShell launcher: a PID is only
// touched when its command line still names the recorded binary and data root.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { defaultPort } from "./paths.mjs";
import * as proc from "./proc.mjs";
import { activeReleaseName, pruneReleases, resolveRelease, setActiveRelease } from "./release.mjs";
import { ensureDirs, loadRepoEnv, log, readJson, utcStamp } from "./util.mjs";
export function logFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `server-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}.log`;
}

function checkPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use on 127.0.0.1. Free it or pass a different port (the phone's saved sign-in is tied to the port).`,
          ),
        );
      } else reject(error);
    });
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

function killOldLogs(logsDir, keep = 7) {
  let names;
  try {
    names = fs.readdirSync(logsDir).filter((name) => /^server-\d{8}\.log$/.test(name));
  } catch {
    return;
  }
  names.sort().reverse().slice(keep).forEach((name) => fs.rmSync(path.join(logsDir, name), { force: true }));
}

export function serverEnvFor(repoRoot, label = "Bots") {
  const { values } = loadRepoEnv(repoRoot);
  return proc.serverEnv({ envFileValues: values, label });
}

async function waitReady({ paths, launchedAt, childPid, timeoutMs = 60000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!proc.isAlive(childPid)) return { ready: false, exited: true };
    const runtime = proc.runtimeState(paths.baseDir);
    if (runtime && runtime.startedAt && Date.parse(runtime.startedAt) >= launchedAt.getTime() - 2000) {
      return { ready: true, runtime };
    }
    await proc.sleep(500);
  }
  return { ready: false, exited: false };
}

export async function startServer({
  paths,
  repoRoot,
  releaseName = null,
  nodeExe = process.execPath,
  port = defaultPort(paths.root),
  label = "Bots",
  waitMs = 60000,
}) {
  ensureDirs([paths.logsDir, paths.runDir, paths.baseDir, paths.workDir]);
  const existing = proc.readState(paths);
  if (existing && proc.isServerProcess(Number(existing.pid), existing)) {
    return { alreadyRunning: true, state: existing };
  }
  const owner = proc.dataRootOwner(paths.baseDir);
  if (owner) {
    throw new Error(`A T3 server (pid ${owner.pid}, ${owner.origin}) already serves ${paths.baseDir}. Two servers must never share a data root.`);
  }
  const release = resolveRelease(paths, releaseName);
  await checkPortFree(port);
  fs.rmSync(paths.stopMarker, { force: true });
  killOldLogs(paths.logsDir);
  const logFile = path.join(paths.logsDir, logFileName());
  const launchedAt = new Date();
  fs.appendFileSync(logFile, `=== ${launchedAt.toISOString()} start release ${release.name} root ${paths.root} base ${paths.baseDir}\n`);

  const child = proc.spawnServe({
    nodeExe,
    binPath: release.bin,
    baseDir: paths.baseDir,
    logFile,
    workDir: paths.workDir,
    port,
    env: serverEnvFor(repoRoot, label),
    detached: true,
  });
  const state = {
    pid: child.pid,
    root: paths.root,
    baseDir: paths.baseDir,
    binPath: release.bin,
    release: release.name,
    logFile,
    port,
    startedAt: launchedAt.toISOString(),
    supervised: false,
  };
  proc.writeState(paths, state);
  const ready = await waitReady({ paths, launchedAt, childPid: child.pid, timeoutMs: waitMs });
  if (!ready.ready) {
    if (ready.exited) {
      const tail = fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-20).join("\n");
      proc.clearState(paths);
      throw new Error(`Personal Bots exited during startup. Last log lines:\n${tail}`);
    }
    process.stderr.write(`Server is running (pid ${child.pid}) but not ready after ${waitMs / 1000}s. Check ${logFile}.\n`);
  }
  return { alreadyRunning: false, state, ready: ready.ready, logFile };
}

// Foreground supervisor for systemd: one child, state file, signals forwarded.
// systemd owns crash restarts (Restart=on-failure) and the kill of the whole
// control group, so a stop never leaves an orphan.
export async function serveForeground({ paths, repoRoot, releaseName = null, nodeExe = process.execPath, port = defaultPort(paths.root), label = "Bots" }) {
  ensureDirs([paths.logsDir, paths.runDir, paths.baseDir, paths.workDir]);
  const owner = proc.dataRootOwner(paths.baseDir);
  if (owner && Number(owner.pid) !== process.pid) {
    throw new Error(`A T3 server (pid ${owner.pid}) already serves ${paths.baseDir}.`);
  }
  const release = resolveRelease(paths, releaseName);
  await checkPortFree(port);
  fs.rmSync(paths.stopMarker, { force: true });
  killOldLogs(paths.logsDir);
  const logFile = path.join(paths.logsDir, logFileName());
  const launchedAt = new Date();
  fs.appendFileSync(logFile, `=== ${launchedAt.toISOString()} serve release ${release.name} root ${paths.root} base ${paths.baseDir}\n`);

  const fd = fs.openSync(logFile, "a");
  const { spawn } = await import("node:child_process");
  const child = spawn(nodeExe, [release.bin, "serve", "--base-dir", paths.baseDir, "--no-browser", "--port", String(port)], {
    cwd: paths.workDir,
    env: serverEnvFor(repoRoot, label),
    stdio: ["ignore", fd, fd],
    detached: false,
  });
  fs.closeSync(fd);
  proc.writeState(paths, {
    pid: child.pid,
    root: paths.root,
    baseDir: paths.baseDir,
    binPath: release.bin,
    release: release.name,
    logFile,
    startedAt: launchedAt.toISOString(),
    supervised: true,
  });

  const exited = new Promise((resolve) => child.once("exit", (exitCode, signal) => resolve({ exitCode, signal })));
  let requestedStop = false;
  const forward = (signal) => {
    requestedStop = true;
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));

  const ready = await waitReady({ paths, launchedAt, childPid: child.pid, timeoutMs: 60000 });
  if (ready.ready) log(`Personal Bots ready: pid ${child.pid}, release ${release.name}, root ${paths.root}`);
  else if (ready.exited) process.stderr.write(`Server exited during startup. See ${logFile}.\n`);

  const { exitCode, signal } = await exited;
  const code = exitCode ?? (signal ? 1 : 0);
  if (!fs.existsSync(paths.stopMarker)) proc.clearState(paths);
  return requestedStop ? 0 : code;
}

export async function stopServer({ paths }) {
  fs.mkdirSync(paths.runDir, { recursive: true });
  // Recorded before the state check: a supervisor waiting to restart a crashed
  // child clears server.json, and the marker is what stops it coming back.
  fs.writeFileSync(paths.stopMarker, `${new Date().toISOString()}\n`);
  const state = proc.readState(paths);
  if (!state) return { stopped: false, reason: "not running (no run/server.json)" };
  const pid = Number(state.pid);
  if (!proc.isAlive(pid)) {
    proc.clearState(paths);
    return { stopped: false, reason: `recorded pid ${pid} has exited` };
  }
  if (!proc.isServerProcess(pid, state)) {
    throw new Error(
      `PID ${pid} is alive but its command line does not name ${state.binPath} and ${state.baseDir}. Refusing to kill it. Delete ${paths.stateFile} if the server is already gone.`,
    );
  }
  const ok = await proc.stopProcessTree(pid);
  if (!ok) throw new Error(`PID ${pid} is still alive after SIGKILL.`);
  proc.clearState(paths);
  return { stopped: true, pid, release: state.release };
}

export function systemdUnitActive(unit = "hbots.service") {
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", unit], { stdio: "ignore" }).status === 0;
}

export async function restartServer({
  paths,
  repoRoot,
  releaseName = null,
  keepReleases = 5,
  viaSystemd = null,
  nodeExe = process.execPath,
  waitMs = 90000,
  port = null,
}) {
  const before = proc.readState(paths);
  const rollbackTarget = before && before.release ? String(before.release) : null;
  const listenPort = port ?? (before && before.port ? Number(before.port) : defaultPort(paths.root));
  if (releaseName) {
    setActiveRelease(paths, releaseName);
    log(`Active release set to ${releaseName}.`);
  }
  const useSystemd = viaSystemd === null ? systemdUnitActive() : viaSystemd;
  let started;
  if (useSystemd) {
    const result = spawnSync("systemctl", ["--user", "restart", "hbots.service"], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`systemctl --user restart hbots.service failed: ${(result.stderr || "").trim()}`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const state = proc.readState(paths);
      if (state && proc.isServerProcess(Number(state.pid), state)) {
        started = { state };
        break;
      }
      await proc.sleep(500);
    }
    if (!started) throw new Error("hbots.service did not bring the server back within the wait.");
  } else {
    await stopServer({ paths });
    started = await startServer({ paths, repoRoot, nodeExe, waitMs: 60000, port: listenPort });
  }
  if (keepReleases > 0) {
    try {
      pruneReleases({ paths, keep: keepReleases, protect: [rollbackTarget].filter(Boolean), running: started.state.release, dryRun: false });
    } catch (error) {
      process.stderr.write(`Release pruning failed: ${error.message}\n`);
    }
  }
  return started;
}

export function describeStatus({ paths }) {
  const state = proc.readState(paths);
  const active = activeReleaseName(paths);
  const runtime = proc.runtimeState(paths.baseDir);
  const alive = state ? proc.isServerProcess(Number(state.pid), state) : false;
  let version = null;
  if (active) {
    version = formatVersionFile(path.join(paths.releasesDir, active, "VERSION"));
  }
  return { root: paths.root, active, state, alive, runtime, version, home: paths.home, baseDir: paths.baseDir };
}

export function formatVersionFile(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

export function writeStateSnapshot(paths, extra = {}) {
  const state = proc.readState(paths);
  if (!state) return null;
  const merged = { ...state, ...extra, checkedAt: utcStamp() };
  proc.writeState(paths, merged);
  return merged;
}
