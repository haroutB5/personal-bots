// Idle gate. Reads only the process tree, the unit's cgroup, the per-thread event logs and the heavy-job lock.
// It never opens the database (26 Oct: another process opening the live state.sqlite crashed the server).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cgroupCpuSeconds, cgroupDirOf, cgroupPids, descendants, liveState, procSnapshot, procStartMs } from "./proc.mjs";
import { run, sleep, round1 } from "./util.mjs";

export const isHelper = (cmd) =>
  /cloudflared/.test(cmd) ||
  /brave/.test(cmd) ||
  /opencode\.exe\s+serve\s+--stdio/.test(cmd) ||
  /codex-code-mode-host/.test(cmd) ||
  /perf-linux-helper/.test(cmd) ||
  /sqlite-snapshot\.cjs/.test(cmd);

export const isSessionRoot = (cmd) =>
  /\sacp$/.test(cmd) || /codex app-server/.test(cmd) || /claude --output-format stream-json/.test(cmd);

/** True while a heavy-job.sh holder (a build, a gate run) owns the lock. flock -n takes and drops it at once. */
export function heavyLockHeld(lockPath) {
  if (!fs.existsSync(lockPath)) return { held: false, holder: null };
  const r = run("flock", ["-n", "-E", "75", lockPath, "true"], { timeout: 10_000 });
  if (r.code === 0) return { held: false, holder: null };
  let holder = null;
  try {
    holder = fs.readFileSync(lockPath, "utf8").trim().split("\n")[0].slice(0, 160) || null;
  } catch {}
  return { held: r.code === 75 || r.code === 1, holder };
}

/**
 * Takes the heavy-job lock for the activation window so a build cannot start between the last idle look and
 * the restart (heavy-job.sh waits for it). The holder is a child this runner started; release() kills only it.
 * Returns null when the lock is already held.
 */
export async function takeHeavyLock(lockPath, label) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const script = `printf 'pid=%s started=%s label=%s cwd=%s\\n' "$$" "$(date -Is)" "$1" "$PWD" > "$2"; exec sleep 7200`;
  const child = spawn("flock", ["-n", "-E", "75", lockPath, "sh", "-c", script, "sh", label, lockPath], { stdio: "ignore", detached: false });
  const outcome = await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve({ exited: code }))),
    sleep(400).then(() => ({ exited: null })),
  ]);
  if (outcome.exited !== null) return null;
  return {
    pid: child.pid,
    release() {
      try {
        child.kill("SIGTERM");
      } catch {}
    },
  };
}

function newestEventLog(dir) {
  let newest = 0;
  let name = null;
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!/^events\..*\.log$/.test(entry)) continue; // rotations (.log.1) are history
      const mtime = fs.statSync(path.join(dir, entry)).mtimeMs;
      if (mtime > newest) {
        newest = mtime;
        name = entry;
      }
    }
  } catch {}
  return { newest, name };
}

/** One look. prev is the previous look's snapshot (for CPU deltas). */
export function takeLook(cfg, prev) {
  const state = liveState(cfg);
  if (!state) return { serverRunning: false };
  const now = procSnapshot();
  const cgDir = prev?.cgDir ?? (cfg.scope || cgroupDirOf(cfg.unit));
  const inCgroup = cgDir ? cgroupPids(cgDir) : null;
  const pids = inCgroup?.length ? new Set(inCgroup) : descendants(now, Number(state.pid));
  const toolProcs = [];
  let cpu = 0;
  for (const pid of pids) {
    const proc = now.get(pid);
    if (!proc || pid === Number(state.pid)) continue;
    if (isHelper(proc.cmdline) || isSessionRoot(proc.cmdline) || /hbots\.mjs\s+serve/.test(proc.cmdline) || /\bbin\.mjs\b.*\bserve\b/.test(proc.cmdline)) continue;
    const before = prev?.snapshot?.get(pid);
    const delta = before ? proc.cpu - before.cpu : 0;
    cpu += Math.max(0, delta);
    const ageMs = Date.now() - procStartMs(proc.startTicks);
    if (delta <= 0.02 && ageMs > cfg.staleLeftoverMs) continue; // old leftover, no work
    toolProcs.push({ pid, ageSec: Math.round(ageMs / 1000), delta: round1(delta), cmd: proc.cmdline.slice(0, 100) });
  }
  const events = newestEventLog(cfg.providerLogs);
  const lock = heavyLockHeld(cfg.heavyLock);
  const cgCpu = cgDir ? cgroupCpuSeconds(cgDir) : null;
  return {
    serverRunning: true,
    snapshot: now,
    cgDir,
    toolProcs,
    cpu: Number(cpu.toFixed(2)),
    cgroupCpuS: cgCpu,
    cgroupCpuDelta: cgCpu !== null && prev?.cgroupCpuS != null ? Number((cgCpu - prev.cgroupCpuS).toFixed(2)) : null,
    eventsAgeMs: events.newest ? Date.now() - events.newest : Number.MAX_SAFE_INTEGER,
    eventsName: events.name,
    heavy: lock,
    at: new Date().toISOString(),
  };
}

/** Pure: why this look is busy (empty list = quiet). */
export function busyReasons(look, cfg) {
  const reasons = [];
  if (look.heavy?.held) reasons.push(`heavy-lock(${look.heavy.holder ?? "held"})`);
  if (look.toolProcs.length)
    reasons.push(`tools=${look.toolProcs.length}(${look.toolProcs.slice(0, 4).map((p) => `${p.cmd.split(" ")[0].split("/").pop()}:${p.ageSec}s`).join(",")})`);
  if (look.cpu > cfg.cpuBudgetS) reasons.push(`cpu=${look.cpu}s`);
  if (look.eventsAgeMs < cfg.eventsQuietMs) reasons.push(`events=${Math.round(look.eventsAgeMs / 1000)}s(${look.eventsName ?? "?"})`);
  return reasons;
}

/**
 * Waits for N quiet looks in a row. One sleep per look (no busy polling); the first look waits one interval so
 * CPU deltas have a window. Returns { idle, looks, waitedS } and calls onLook after each look.
 */
export async function waitForIdle(cfg, { onLook, looksLimit = Infinity, intervalMs = cfg.lookMs } = {}) {
  const started = Date.now();
  const deadline = started + cfg.marathonMs;
  const looks = [];
  let prev = takeLook(cfg, null);
  let quiet = 0;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const look = takeLook(cfg, prev);
    if (!look.serverRunning) throw new Error("the live server stopped during the idle wait; not restarting anything");
    const reasons = busyReasons(look, cfg);
    quiet = reasons.length ? 0 : quiet + 1;
    const entry = {
      at: look.at,
      quiet,
      cpu: look.cpu,
      cgroupCpuDelta: look.cgroupCpuDelta,
      eventsAgeSec: look.eventsAgeMs === Number.MAX_SAFE_INTEGER ? null : Math.round(look.eventsAgeMs / 1000),
      toolProcs: look.toolProcs.length,
      heavyLock: look.heavy.held,
      busyReason: reasons.length ? reasons.join(" ") : null,
    };
    looks.push(entry);
    onLook?.(entry, quiet);
    prev = look;
    if (quiet >= cfg.quietLooks) return { idle: true, looks, waitedS: round1((Date.now() - started) / 1000) };
    if (looks.length >= looksLimit) return { idle: false, looks, waitedS: round1((Date.now() - started) / 1000) };
  }
  return { idle: false, looks, waitedS: round1((Date.now() - started) / 1000), timedOut: true };
}

/** A short window check right before the restart: lock, tools, events, and CPU over windowMs. */
export async function quickIdleCheck(cfg, windowMs = 3000) {
  const first = takeLook(cfg, null);
  if (!first.serverRunning) return { idle: false, reasons: ["server-not-running"] };
  await sleep(windowMs);
  const second = takeLook(cfg, first);
  if (!second.serverRunning) return { idle: false, reasons: ["server-not-running"] };
  const scaled = Math.max(0.15, cfg.cpuBudgetS * (windowMs / cfg.lookMs));
  const reasons = busyReasons(second, { ...cfg, cpuBudgetS: scaled });
  return { idle: reasons.length === 0, reasons, look: second };
}
