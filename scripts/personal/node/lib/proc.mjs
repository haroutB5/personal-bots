// Process identity and lifecycle. A server is only ever identified by a
// recorded PID whose command line still names its release binary and data
// root. Nothing here matches by process name, and nothing kills an unverified
// PID.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pbHome } from "./paths.mjs";

const isWindows = process.platform === "win32";

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function commandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (isWindows) {
    const script =
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
      `if ($p) { [Console]::Out.Write($p.CommandLine) }`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    const text = (result.stdout || "").trim();
    return text || null;
  }
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const text = raw.split("\0").filter(Boolean).join(" ").trim();
    return text || null;
  } catch {
    return null;
  }
}

function samePath(text, target) {
  if (!text || !target) return false;
  const lower = isWindows ? text.toLowerCase() : text;
  const needle = isWindows ? target.toLowerCase() : target;
  if (lower.includes(needle)) return true;
  // /proc shows the resolved absolute path; compare real paths when possible.
  try {
    const real = fs.realpathSync(target);
    return lower.includes(isWindows ? real.toLowerCase() : real);
  } catch {
    return false;
  }
}

export function isServerProcess(pid, { binPath, baseDir }) {
  if (!isAlive(pid) || !binPath || !baseDir) return false;
  const text = commandLine(pid);
  if (!text) return false;
  return samePath(text, binPath) && samePath(text, baseDir);
}

export function readState(paths) {
  try {
    return JSON.parse(fs.readFileSync(paths.stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function writeState(paths, state) {
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(paths.pidFile, `${state.pid}\n`);
}

export function clearState(paths) {
  fs.rmSync(paths.stateFile, { force: true });
  fs.rmSync(paths.pidFile, { force: true });
}

export function runtimeState(baseDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(baseDir, "userdata", "server-runtime.json"), "utf8"));
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Environment for a launched server: repo public config from .env, the same
// dev-origin variables the PowerShell launcher clears, and an explicit label.
export function serverEnv({ envFileValues = {}, label = "Bots" } = {}) {
  const env = { ...process.env };
  for (const name of [
    "VITE_DEV_SERVER_URL",
    "VITE_HTTP_URL",
    "VITE_WS_URL",
    "T3CODE_HOME",
    "T3CODE_PORT",
    "T3CODE_MODE",
    "T3CODE_PERSONAL_STALL_DIR",
    "T3CODE_PERSONAL_SCHEDULERS",
  ]) {
    delete env[name];
  }
  for (const [key, value] of Object.entries(envFileValues)) {
    if (value !== undefined && value !== "") env[key] = value;
  }
  env.T3CODE_ENVIRONMENT_LABEL = label;
  return env;
}

export function spawnServe({ nodeExe, binPath, baseDir, logFile, workDir, port, env, detached = true }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const fd = fs.openSync(logFile, "a");
  try {
    const args = [binPath, "serve", "--base-dir", baseDir, "--no-browser"];
    if (port > 0) args.push("--port", String(port));
    const child = spawn(nodeExe, args, {
      cwd: workDir,
      env,
      detached,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(fd);
  }
}

async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(200);
  }
  return !isAlive(pid);
}

// Stops exactly the recorded PID. A detached child is a process-group leader,
// so a group TERM reaches its relay and helpers too; the fallback kills only
// that PID.
export async function stopProcessTree(pid, { timeoutMs = 15000 } = {}) {
  if (!isAlive(pid)) return true;
  if (isWindows) {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return waitGone(pid, timeoutMs);
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return !isAlive(pid);
    }
  }
  if (await waitGone(pid, timeoutMs)) return true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return waitGone(pid, 5000);
}

export function dataRootOwner(baseDir) {
  const runtime = runtimeState(baseDir);
  if (!runtime || !runtime.pid) return null;
  if (!isAlive(Number(runtime.pid))) return null;
  return { pid: Number(runtime.pid), origin: runtime.origin };
}

