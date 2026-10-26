// @effect-diagnostics nodeBuiltinImport:off - discovery reads /proc, sockets and spawns hyprctl directly; no Effect service fits a one-shot probe.
// @effect-diagnostics globalTimers:off - process timeouts on a callback-based child.
/**
 * Finding the live Hyprland session from the hbots server.
 *
 * The systemd unit usually inherits `WAYLAND_DISPLAY` and
 * `HYPRLAND_INSTANCE_SIGNATURE`, but discovery must not depend on that: the
 * server can be started from another context (a shell, a test root, a
 * recovery boot). The order is the one in SPEC.md section 8.1:
 *
 * 1. `PB_DESKTOP_*` overrides (tests and recovery).
 * 2. The environment, if the Wayland socket exists and belongs to this user.
 * 3. `hyprctl instances -j`, picking an instance whose socket exists and
 *    whose pid belongs to this user.
 * 4. A validation roundtrip (`hyprctl version`, `monitors -j`).
 *
 * A failure is a sentence for the user, never a crash: the desktop reports
 * `available: false` with that sentence.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface LinuxSession {
  readonly waylandDisplay: string;
  readonly xdgRuntimeDir: string;
  /** Hyprland's instance signature: the name of its runtime directory. */
  readonly hyprlandInstance: string;
  readonly uid: number;
}

export class LinuxSessionError extends Error {}

/** Run a command with no shell, a timeout, and a bounded output. */
export function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly stdin?: string;
    readonly maxBytes?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
      windowsHide: true,
    });
    const limit = options.maxBytes ?? 4_000_000;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new LinuxSessionError(`${command} did not answer within ${options.timeoutMs ?? 10_000} ms.`));
    }, options.timeoutMs ?? 10_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < limit) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < limit) stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LinuxSessionError(`${command} could not run: ${error.message}`));
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}

const isFile = (path: string): boolean => {
  try {
    return NodeFS.statSync(path).isSocket() || NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

const ownedByUid = (path: string, uid: number): boolean => {
  try {
    return NodeFS.statSync(path).uid === uid;
  } catch {
    return false;
  }
};

/** The environment hyprctl, grim and the helper need for one session. */
export function sessionEnv(session: LinuxSession, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    XDG_RUNTIME_DIR: session.xdgRuntimeDir,
    WAYLAND_DISPLAY: session.waylandDisplay,
    HYPRLAND_INSTANCE_SIGNATURE: session.hyprlandInstance,
  };
}

/** `hyprctl` against this session. Rejects with the tool's own error line. */
export async function hyprctl(
  session: LinuxSession,
  args: ReadonlyArray<string>,
  timeoutMs = 10_000,
): Promise<string> {
  const result = await runCommand("hyprctl", args, {
    env: sessionEnv(session),
    timeoutMs,
    maxBytes: 8_000_000,
  });
  if (result.code !== 0) {
    throw new LinuxSessionError(
      `hyprctl ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
    );
  }
  return result.stdout;
}

export async function hyprctlJson<T>(session: LinuxSession, args: ReadonlyArray<string>): Promise<T> {
  const text = await hyprctl(session, [...args, "-j"]);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LinuxSessionError(`hyprctl ${args.join(" ")} returned something other than JSON.`);
  }
}

interface HyprctlInstance {
  readonly instance?: string;
  readonly pid?: number;
  readonly wl_socket?: string;
}

async function fromInstances(uid: number): Promise<LinuxSession | null> {
  const runtime = `/run/user/${uid}`;
  if (!NodeFS.existsSync(runtime)) return null;
  let text: string;
  try {
    const result = await runCommand("hyprctl", ["instances", "-j"], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtime },
      timeoutMs: 5_000,
    });
    if (result.code !== 0) return null;
    text = result.stdout;
  } catch {
    return null;
  }
  let listed: HyprctlInstance[];
  try {
    listed = JSON.parse(text) as HyprctlInstance[];
  } catch {
    return null;
  }
  for (const entry of Array.isArray(listed) ? listed : []) {
    const instance = typeof entry.instance === "string" ? entry.instance : "";
    const socket = typeof entry.wl_socket === "string" ? entry.wl_socket : "";
    const pid = typeof entry.pid === "number" ? entry.pid : 0;
    if (instance.length === 0 || socket.length === 0 || pid <= 0) continue;
    if (!isFile(NodePath.join(runtime, socket))) continue;
    if (!ownedByUid(`/proc/${pid}`, uid)) continue;
    return {
      waylandDisplay: socket,
      xdgRuntimeDir: runtime,
      hyprlandInstance: instance,
      uid,
    };
  }
  return null;
}

/**
 * Finds the live session, then proves it answers. Throws LinuxSessionError
 * with a sentence that can be shown to the user.
 */
export async function discoverLinuxSession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LinuxSession> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const overrideDisplay = env.PB_DESKTOP_WAYLAND_DISPLAY?.trim();
  const overrideInstance = env.PB_DESKTOP_HYPRLAND_INSTANCE?.trim();
  const runtime = env.XDG_RUNTIME_DIR?.trim() || `/run/user/${uid}`;

  const candidates: LinuxSession[] = [];
  if (overrideInstance !== undefined && overrideInstance.length > 0) {
    candidates.push({
      waylandDisplay: overrideDisplay || env.WAYLAND_DISPLAY?.trim() || "wayland-1",
      xdgRuntimeDir: runtime,
      hyprlandInstance: overrideInstance,
      uid,
    });
  }
  const envDisplay = env.WAYLAND_DISPLAY?.trim();
  const envInstance = env.HYPRLAND_INSTANCE_SIGNATURE?.trim();
  if (envDisplay !== undefined && envInstance !== undefined && envDisplay.length > 0 && envInstance.length > 0) {
    candidates.push({
      waylandDisplay: envDisplay,
      xdgRuntimeDir: runtime,
      hyprlandInstance: envInstance,
      uid,
    });
  }
  const listed = await fromInstances(uid);
  if (listed !== null) candidates.push(listed);

  const tried: string[] = [];
  for (const session of candidates) {
    const socket = NodePath.join(session.xdgRuntimeDir, session.waylandDisplay);
    if (!isFile(socket)) {
      tried.push(`${session.waylandDisplay} is not in ${session.xdgRuntimeDir}`);
      continue;
    }
    if (!ownedByUid(socket, uid)) {
      tried.push(`${session.waylandDisplay} belongs to another user`);
      continue;
    }
    try {
      // Two cheap roundtrips: the compositor is there and it knows its screens.
      await hyprctl(session, ["version"], 5_000);
      await hyprctl(session, ["monitors"], 5_000);
      return session;
    } catch (error) {
      tried.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new LinuxSessionError(
    candidates.length === 0
      ? "No Hyprland session was found. The desktop tools need the bot server to run inside your graphical session, or PB_DESKTOP_HYPRLAND_INSTANCE set to it."
      : `No usable Hyprland session: ${tried.join("; ").slice(0, 400)}`,
  );
}

/** One monitor in the units every tool and gesture uses: logical layout pixels. */
export interface LogicalMonitor {
  readonly index: number;
  readonly id: number;
  readonly name: string;
  readonly primary: boolean;
  readonly focused: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly dpi: number;
  readonly dpmsStatus: boolean;
}

interface RawMonitor {
  readonly id?: number;
  readonly name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly scale?: number;
  readonly focused?: boolean;
  readonly dpmsStatus?: boolean;
}

/**
 * Hyprland reports physical pixels plus a scale and logical origins. The app,
 * the helper and `hyprctl cursorpos` all speak logical pixels, so every monitor
 * is converted once, here. The primary is the monitor at 0,0 (else the
 * focused one, else the first), matching SPEC.md 4.1.
 */
export function logicalMonitors(raw: ReadonlyArray<RawMonitor>): LogicalMonitor[] {
  const converted = raw.map((entry, index) => {
    const scale = typeof entry.scale === "number" && entry.scale > 0 ? entry.scale : 1;
    return {
      index,
      id: typeof entry.id === "number" ? entry.id : index,
      name: typeof entry.name === "string" ? entry.name : `monitor-${index}`,
      primary: false,
      focused: entry.focused === true,
      x: typeof entry.x === "number" ? entry.x : 0,
      y: typeof entry.y === "number" ? entry.y : 0,
      width: Math.max(1, Math.round((entry.width ?? 1) / scale)),
      height: Math.max(1, Math.round((entry.height ?? 1) / scale)),
      scale,
      dpi: Math.round(96 * scale),
      dpmsStatus: entry.dpmsStatus !== false,
    };
  });
  const atOrigin = converted.find((entry) => entry.x === 0 && entry.y === 0);
  const primary = atOrigin ?? converted.find((entry) => entry.focused) ?? converted[0];
  return converted.map((entry) => ({ ...entry, primary: entry.index === primary?.index }));
}

export interface RawActiveWindow {
  readonly address?: string;
  readonly title?: string;
  readonly class?: string;
  readonly workspace?: { readonly id?: number; readonly name?: string };
  readonly monitor?: number;
  readonly at?: ReadonlyArray<number>;
  readonly size?: ReadonlyArray<number>;
}

export interface ActiveWindow {
  readonly title: string;
  readonly class: string;
  readonly address: string;
  readonly workspace: string;
  readonly monitor: number;
}

export function activeWindow(raw: RawActiveWindow | null | undefined): ActiveWindow | null {
  if (raw === null || raw === undefined) return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const windowClass = typeof raw.class === "string" ? raw.class : "";
  if (title.length === 0 && windowClass.length === 0) return null;
  return {
    title,
    class: windowClass,
    address: typeof raw.address === "string" ? raw.address : "",
    workspace:
      typeof raw.workspace?.name === "string"
        ? raw.workspace.name
        : String(raw.workspace?.id ?? ""),
    monitor: typeof raw.monitor === "number" ? raw.monitor : 0,
  };
}

/** The lock is Omarchy's quickshell ext-session-lock, not hyprlock. */
export async function sessionLocked(session: LinuxSession): Promise<boolean> {
  try {
    const result = await runCommand("omarchy-shell", ["lock", "isLocked"], {
      env: sessionEnv(session),
      timeoutMs: 3_000,
    });
    const text = (result.stdout || result.stderr).trim().toLowerCase();
    if (text === "true") return true;
    if (text === "false") return false;
  } catch {
    // Fall through to the next oracle.
  }
  try {
    // Prints the lock program that is up, and nothing while unlocked.
    const result = await runCommand("omarchy-hyprland-session-locked", [], {
      env: sessionEnv(session),
      timeoutMs: 3_000,
    });
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
