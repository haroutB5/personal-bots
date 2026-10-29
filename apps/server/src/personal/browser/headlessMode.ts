// @effect-diagnostics nodeBuiltinImport:off
/**
 * Whether the shared browser starts headed or headless, and the graphical
 * session it should use.
 *
 * The shared browser is never watched on the laptop's own screen: the phone
 * sees it through Chrome's screencast, which works headless exactly the same.
 * Headed is still preferred when a session exists, because it lets the owner
 * sign in on the laptop.
 *
 * hbots starts at boot through linger, before Hyprland exists, so the service
 * environment has no `WAYLAND_DISPLAY`, `DISPLAY` or `DBUS_SESSION_BUS_ADDRESS`
 * and freezing it at service start would never give the browser a display. The
 * session is therefore looked up at each launch: the `wayland-N` socket in
 * `$XDG_RUNTIME_DIR`, the Hyprland instance directory under it, and the user
 * bus socket. With no session, the launch falls back to headless instead of
 * failing with Chrome's "no XServer" error.
 *
 * `T3CODE_PERSONAL_BROWSER_HEADLESS=1` forces headless anywhere;
 * `T3CODE_PERSONAL_BROWSER_HEADED=1` forces headed (the operator's explicit
 * choice wins and the launch reports the real error).
 *
 * @module personal/browser/headlessMode
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const BROWSER_HEADLESS_ENV = "T3CODE_PERSONAL_BROWSER_HEADLESS";
export const BROWSER_HEADED_ENV = "T3CODE_PERSONAL_BROWSER_HEADED";

const on = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value?.trim() ?? "");

/** True when this host can show a window: a display or a Wayland compositor is set. */
export function hasGraphicalSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const display = env.DISPLAY?.trim() ?? "";
  const wayland = env.WAYLAND_DISPLAY?.trim() ?? "";
  return display !== "" || wayland !== "";
}

export interface GraphicalSession {
  /** A compositor or X server was found, so a window can be shown. */
  readonly available: boolean;
  /** Variables to add to the browser's environment (never removes anything). */
  readonly env: Readonly<Record<string, string>>;
  /** One line for the launch log: what was found and where. */
  readonly detail: string;
}

export interface GraphicalSessionDeps {
  readonly platform?: NodeJS.Platform;
  readonly runtimeDir?: string;
  readonly exists?: (path: string) => boolean;
  readonly readdir?: (path: string) => ReadonlyArray<string>;
}

const defaultRuntimeDir = (env: NodeJS.ProcessEnv): string => {
  const configured = env.XDG_RUNTIME_DIR?.trim();
  if (configured !== undefined && configured !== "") return configured;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined ? "" : `/run/user/${uid}`;
};

/**
 * The live graphical session, looked up now rather than inherited.
 *
 * Only paths under the caller's own `XDG_RUNTIME_DIR` are read. A `wayland-N`
 * socket is preferred (Hyprland is Wayland); `DISPLAY` alone is enough for X11.
 */
export function discoverGraphicalSession(
  env: NodeJS.ProcessEnv = process.env,
  deps: GraphicalSessionDeps = {},
): GraphicalSession {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform decides whether a session exists; tests inject it.
  const platform = deps.platform ?? NodeOS.platform();
  const readdir =
    deps.readdir ??
    ((dir: string) => {
      try {
        return NodeFS.readdirSync(dir);
      } catch {
        return [];
      }
    });
  const exists = deps.exists ?? ((path: string) => NodeFS.existsSync(path));

  if (platform === "win32" || platform === "darwin") {
    return { available: true, env: {}, detail: "desktop platform" };
  }

  const runtimeDir = deps.runtimeDir ?? defaultRuntimeDir(env);
  const sessionEnv: Record<string, string> = {};
  const found: string[] = [];

  let wayland = env.WAYLAND_DISPLAY?.trim() ?? "";
  if (wayland === "" && runtimeDir !== "") {
    // wayland-0 first, then any other compositor instance.
    wayland =
      readdir(runtimeDir)
        .filter((entry) => /^wayland-\d+$/.test(entry))
        .toSorted((a, b) => Number(a.slice(8)) - Number(b.slice(8)))[0] ?? "";
  }
  if (wayland !== "" && (runtimeDir === "" || exists(NodePath.join(runtimeDir, wayland)))) {
    sessionEnv.WAYLAND_DISPLAY = wayland;
    found.push(`wayland ${wayland}`);
  }

  const hyprland = env.HYPRLAND_INSTANCE_SIGNATURE?.trim() ?? "";
  if (hyprland !== "") {
    sessionEnv.HYPRLAND_INSTANCE_SIGNATURE = hyprland;
  } else if (runtimeDir !== "") {
    const instances = readdir(NodePath.join(runtimeDir, "hypr")).filter((entry) => entry !== "");
    if (instances.length > 0) {
      sessionEnv.HYPRLAND_INSTANCE_SIGNATURE = instances[0]!;
      found.push("Hyprland");
    }
  }

  const display = env.DISPLAY?.trim() ?? "";
  if (display !== "") {
    sessionEnv.DISPLAY = display;
    found.push(`X ${display}`);
  }

  if ((env.DBUS_SESSION_BUS_ADDRESS?.trim() ?? "") !== "") {
    sessionEnv.DBUS_SESSION_BUS_ADDRESS = env.DBUS_SESSION_BUS_ADDRESS!.trim();
  } else {
    const bus = runtimeDir === "" ? "" : NodePath.join(runtimeDir, "bus");
    if (bus !== "" && exists(bus)) {
      sessionEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
      found.push("user bus");
    }
  }

  const available = found.some((entry) => entry.startsWith("wayland") || entry.startsWith("X "));
  return {
    available,
    env: sessionEnv,
    detail: found.length === 0 ? "no graphical session found" : found.join(", "),
  };
}

export function resolveBrowserHeadless(
  env: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform decides whether a graphical session is expected; tests inject it.
  platform: NodeJS.Platform = NodeOS.platform(),
  sessionAvailable?: boolean,
): boolean {
  if (on(env[BROWSER_HEADLESS_ENV])) return true;
  if (on(env[BROWSER_HEADED_ENV])) return false;
  // Windows and macOS desktops always have one.
  if (platform === "win32" || platform === "darwin") return false;
  return !(sessionAvailable ?? hasGraphicalSession(env));
}

/** True when the owner pinned the mode, so the launch must not decide for itself. */
export function browserModePinned(env: NodeJS.ProcessEnv = process.env): boolean {
  return on(env[BROWSER_HEADLESS_ENV]) || on(env[BROWSER_HEADED_ENV]);
}

/**
 * The message a failed launch shows. Chrome's own "no XServer" notice is what
 * the operator needs to read; never the browserType wrapper around it.
 */
export function describeLaunchFailure(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() ?? message.trim();
  if (/x ?server|missing x|Xvfb/i.test(message)) {
    return "The browser needs a graphical session and none was found. Log in on the laptop, or set T3CODE_PERSONAL_BROWSER_HEADLESS=1.";
  }
  return `Chrome failed to start: ${firstLine}`;
}
