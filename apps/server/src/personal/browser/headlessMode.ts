// @effect-diagnostics nodeBuiltinImport:off
/**
 * Whether the shared browser starts headed or headless.
 *
 * The shared browser is never watched on the laptop's own screen: the phone
 * sees it through Chrome's screencast, which works headless exactly the same.
 * Headed is the default because it lets the owner sign in on the laptop, but a
 * Linux server started by systemd has no `DISPLAY`/`WAYLAND_DISPLAY`, and
 * Chrome then refuses to start at all ("launched a headed browser without
 * having a XServer running"). So a Linux host with no graphical session takes
 * the headless path instead of failing.
 *
 * `T3CODE_PERSONAL_BROWSER_HEADLESS=1` forces headless anywhere;
 * `T3CODE_PERSONAL_BROWSER_HEADED=1` forces headed, even without a display
 * (the operator's explicit choice wins and the launch reports the real error).
 *
 * @module personal/browser/headlessMode
 */
import * as NodeOS from "node:os";

export const BROWSER_HEADLESS_ENV = "T3CODE_PERSONAL_BROWSER_HEADLESS";
export const BROWSER_HEADED_ENV = "T3CODE_PERSONAL_BROWSER_HEADED";

const on = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value?.trim() ?? "");

/** True when this host can show a window: a display or a Wayland compositor is set. */
export function hasGraphicalSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const display = env.DISPLAY?.trim() ?? "";
  const wayland = env.WAYLAND_DISPLAY?.trim() ?? "";
  return display !== "" || wayland !== "";
}

export function resolveBrowserHeadless(
  env: NodeJS.ProcessEnv = process.env,
  // oxlint-disable-next-line t3code/no-global-process-runtime -- the host platform decides whether a graphical session is expected; tests inject it.
  platform: NodeJS.Platform = NodeOS.platform(),
): boolean {
  if (on(env[BROWSER_HEADLESS_ENV])) return true;
  if (on(env[BROWSER_HEADED_ENV])) return false;
  // Windows and macOS desktops always have one.
  if (platform === "win32" || platform === "darwin") return false;
  return !hasGraphicalSession(env);
}
