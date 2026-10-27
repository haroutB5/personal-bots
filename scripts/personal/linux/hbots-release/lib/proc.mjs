// Linux process facts from /proc and the unit's cgroup. Nothing here touches the database.
import fs from "node:fs";
import path from "node:path";
import { run, systemctl, readJson } from "./util.mjs";

const HZ = 100; // USER_HZ is 100 on every Linux build we run

export function procSnapshot() {
  const map = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let stat;
    let cmdline;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
    } catch {
      continue;
    }
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    map.set(pid, { pid, ppid: Number(rest[1]), startTicks: Number(rest[19]), cpu: (Number(rest[11]) + Number(rest[12])) / HZ, cmdline });
  }
  return map;
}

export function descendants(map, rootPid) {
  const children = new Map();
  for (const p of map.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const out = new Set();
  const stack = [rootPid];
  while (stack.length) {
    for (const child of children.get(stack.pop()) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

export function procStartMs(startTicks) {
  try {
    const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return Date.now() - uptime * 1000 + (startTicks / HZ) * 1000;
  } catch {
    return Date.now();
  }
}

export function isServerProcess(pid, binPath) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return cmdline.includes(binPath) && /\bserve\b/.test(cmdline);
  } catch {
    return false;
  }
}

/** server.json, but only when its pid is still the recorded server process. */
export function liveState(cfg) {
  const state = readJson(cfg.serverJson);
  if (!state?.pid) return null;
  if (!isServerProcess(Number(state.pid), String(state.binPath ?? ""))) return null;
  return state;
}

export function cgroupDirOf(unit) {
  const show = run("systemctl", ["--user", "show", unit, "-p", "ControlGroup", "--value"], { timeout: 15_000 });
  const rel = show.out.trim();
  return rel ? path.join("/sys/fs/cgroup", rel) : null;
}

export function cgroupPids(dir) {
  try {
    return fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return null;
  }
}

export function cgroupCpuSeconds(dir) {
  try {
    const m = /^usage_usec (\d+)/m.exec(fs.readFileSync(path.join(dir, "cpu.stat"), "utf8"));
    return m ? Number(m[1]) / 1e6 : null;
  } catch {
    return null;
  }
}

/** The unified cgroup path from /proc/<pid>/cgroup's last line ("0::/user.slice/..."), or null. */
export function cgroupPathFromProcText(text) {
  const line = text.trim().split("\n").pop() ?? "";
  const m = /^\d+::(.+)$/.exec(line);
  return m?.[1] ?? null;
}

/** The /sys/fs/cgroup directory of one process, read from /proc (no systemctl needed). */
export function cgroupDirFromPid(pid) {
  try {
    const rel = cgroupPathFromProcText(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"));
    return rel === null ? null : path.join("/sys/fs/cgroup", rel);
  } catch {
    return null;
  }
}

/** pid -> cgroup path for a set of pids (null when unreadable). */
export function cgroupMembership(pids, read = (pid) => fs.readFileSync(`/proc/${pid}/cgroup`, "utf8")) {
  const map = new Map();
  for (const pid of pids) {
    try {
      map.set(pid, cgroupPathFromProcText(read(pid)));
    } catch {
      map.set(pid, null);
    }
  }
  return map;
}

/**
 * The process-tree fallback keeps only processes in the server's own cgroup.
 * A process the server forked but systemd moved into its own scope (the
 * computer-use Chromium in app-org.chromium.Chromium-*.scope) is still a
 * descendant, yet it is not work hbots is doing, so it must not hold a release.
 */
export function onlyInCgroup(pids, members, serverPath) {
  if (serverPath === null) return new Set(pids);
  const out = new Set();
  for (const pid of pids) if (members.get(pid) === serverPath) out.add(pid);
  return out;
}

/** Is this pid inside the given unit's cgroup? (Used to prove the runner is outside hbots.service.) */
export function cgroupOfPid(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("\n").pop().replace(/^0::/, "");
  } catch {
    return null;
  }
}

export function niceOfPid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
  } catch {
    return null;
  }
}

/** Listener pids on 127.0.0.1:port, from ss. */
export function listenerPids(port) {
  const r = run("ss", ["-ltnpH", "sport", "=", `:${port}`], { timeout: 15_000 });
  const pids = new Set();
  for (const line of r.out.split("\n")) {
    if (!/127\.0\.0\.1:|\[::1\]:|0\.0\.0\.0:|\*:/.test(line)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
  }
  return [...pids];
}

/** The runner's own cost: CPU seconds and peak RSS, plus the transient unit's cgroup totals when available. */
export function selfStats(unitName) {
  const out = {};
  try {
    const stat = fs.readFileSync("/proc/self/stat", "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    out.cpuSeconds = Number(((Number(rest[11]) + Number(rest[12])) / HZ).toFixed(2));
    out.childCpuSeconds = Number(((Number(rest[13]) + Number(rest[14])) / HZ).toFixed(2));
    const status = fs.readFileSync("/proc/self/status", "utf8");
    out.peakRssMb = Math.round(Number(/^VmHWM:\s+(\d+)/m.exec(status)?.[1] ?? 0) / 1024);
    out.rssMb = Math.round(Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) / 1024);
  } catch {}
  if (unitName) {
    const show = systemctl(["show", unitName, "-p", "CPUUsageNSec", "-p", "MemoryPeak", "--value"], 15_000);
    const [cpu, mem] = show.out.split("\n");
    if (/^\d+$/.test(cpu ?? "")) out.unitCpuSeconds = Number((Number(cpu) / 1e9).toFixed(2));
    if (/^\d+$/.test(mem ?? "")) out.unitPeakMemoryMb = Math.round(Number(mem) / 1048576);
  }
  return out;
}
