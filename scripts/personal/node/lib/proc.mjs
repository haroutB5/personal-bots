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
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      },
    );
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
    return JSON.parse(
      fs.readFileSync(path.join(baseDir, "userdata", "server-runtime.json"), "utf8"),
    );
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

export function spawnServe({
  nodeExe,
  binPath,
  baseDir,
  logFile,
  workDir,
  port,
  env,
  detached = true,
}) {
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

/** Linux only: one PID's state, parent and process group, or null. */
function readProcStat(pid) {
  if (isWindows) return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may hold spaces and parentheses; the fields start after
    // the last ')': state ppid pgrp ...
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]) };
  } catch {
    return null;
  }
}

function livePids() {
  if (isWindows) return [];
  try {
    return fs
      .readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number);
  } catch {
    return [];
  }
}

/** The process group a just-spawned detached child leads (Linux), or null. */
export function processGroupOf(pid) {
  return readProcStat(pid)?.pgrp ?? null;
}

/**
 * Every live PID in one process group. The group outlives its leader: a
 * crashed server leaves its fake CLIs and grandchildren in the same group.
 */
export function processGroupPids(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 1) return [];
  return livePids().filter((pid) => readProcStat(pid)?.pgrp === pgid);
}

/**
 * Live PIDs running this root's fake Claude CLI (`<root>/fake/...`). They are
 * test providers, never a helper: a harness that passes `--root <root>` names
 * the root too and must not be touched, so matching the root alone is unsafe.
 */
export function fakeProcessPids(root) {
  if (isWindows) return [];
  const needle = path.join(path.resolve(root), "fake");
  return livePids().filter((pid) => {
    if (pid === process.pid) return false;
    const text = commandLine(pid);
    return text !== null && text.includes(needle);
  });
}

async function waitTreeGone({ pid, group, root, trustedGroup }, timeoutMs) {
  // A live PID that no longer names the root is not the tree's any more (a
  // recycled id): waiting for it would hold the stop open for nothing.
  const stillThere = () =>
    (isAlive(pid) && (root === undefined || namesRoot(pid, root))) ||
    (trustedGroup && processGroupPids(group).length > 0) ||
    (root !== undefined && fakeProcessPids(root).length > 0);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillThere()) return true;
    await sleep(200);
  }
  return !stillThere();
}

/** True when a live PID's command line names this root: the only proof it is the tree's. */
export function namesRoot(pid, root) {
  if (root === undefined) return false;
  const text = commandLine(pid);
  return text !== null && samePath(text, root);
}

/**
 * PIDs that may be signalled for a root: each one's own command line must name
 * the root. A record planted in /tmp can name any PID or group; without this
 * check its stop would kill an unrelated process.
 */
function ownedByRoot(pids, root) {
  return pids.filter((pid) => pid !== process.pid && namesRoot(pid, root));
}

/**
 * Stops a throwaway server's whole tree, not just its leader: the recorded PID,
 * its process group and anything whose command line still names the root. A
 * detached server leads its own group, so the group reaches the relay, the fake
 * Claude CLIs and their children.
 *
 * Every process is signalled only when its own command line still names the
 * root, so a recycled group id, a stale record or a planted one cannot take an
 * unrelated process down with it. The group is signalled as a group only when
 * one of its members names the root.
 *
 * `root` and `pgid` are optional for the other callers that stop one PID tree.
 */
export async function stopProcessTree(pid, { timeoutMs = 15000, pgid, root } = {}) {
  if (isWindows) {
    if (!isAlive(pid)) return true;
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return waitGone(pid, timeoutMs);
  }
  // No root to verify against (the live server's own stop): the recorded PID is
  // the identity, as before.
  if (root === undefined) {
    const group = Number.isInteger(pgid) && pgid > 1 ? pgid : pid;
    const groupBefore = processGroupPids(group);
    if (!isAlive(pid) && groupBefore.length === 0) return true;
    const trustedGroup = isAlive(pid) || groupBefore.length > 0;
    const signal = (name) => {
      if (trustedGroup) {
        try {
          process.kill(-group, name);
        } catch {
          /* no members left in the group */
        }
      }
      for (const target of new Set([...(trustedGroup ? [] : groupBefore), pid])) {
        try {
          process.kill(target, name);
        } catch {
          /* already gone */
        }
      }
    };
    signal("SIGTERM");
    const gone = () => waitTreeGone({ pid, group, root: undefined, trustedGroup }, timeoutMs);
    if (await gone()) return true;
    signal("SIGKILL");
    return waitTreeGone({ pid, group, root: undefined, trustedGroup }, 5000);
  }
  const group = Number.isInteger(pgid) && pgid > 1 ? pgid : pid;
  const groupBefore = ownedByRoot(processGroupPids(group), root);
  const fakeBefore = fakeProcessPids(root);
  const leaderBefore = ownedByRoot([pid], root);
  if (groupBefore.length === 0 && fakeBefore.length === 0 && leaderBefore.length === 0) {
    return true;
  }
  const trustedGroup = leaderBefore.length > 0 || groupBefore.length > 0;
  const signal = (name) => {
    // The whole group when it is ours. A fake CLI that left the group is still
    // ours and is killed by its captured PID; a test harness that only names
    // the root (`--root <root>`) never matches `<root>/fake` and is left alone.
    if (trustedGroup) {
      try {
        process.kill(-group, name);
      } catch {
        /* no members left in the group */
      }
    }
    for (const target of new Set([...leaderBefore, ...fakeBefore, ...groupBefore])) {
      try {
        process.kill(target, name);
      } catch {
        /* already gone */
      }
    }
  };
  signal("SIGTERM");
  const gone = () => waitTreeGone({ pid, group, root, trustedGroup }, timeoutMs);
  if (await gone()) return true;
  signal("SIGKILL");
  return waitTreeGone({ pid, group, root, trustedGroup }, 5000);
}

export function dataRootOwner(baseDir) {
  const runtime = runtimeState(baseDir);
  if (!runtime || !runtime.pid) return null;
  if (!isAlive(Number(runtime.pid))) return null;
  return { pid: Number(runtime.pid), origin: runtime.origin };
}
