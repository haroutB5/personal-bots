/**
 * Kill switches for Android speed changes, read from the server's `perfOff` list on each
 * compat check (src/compat.ts) and kept in memory. A server that sends none, or no answer yet,
 * leaves every optimisation on. Turn one off with PB_PERF_OFF=<name> on the server.
 */

export type AndroidPerfOptimization =
  /** Start a chat's snapshot request at the press, before the screen mounts. */
  | "android-preload-chat"
  /** Check for an app update when the connection comes back, at most once a minute. */
  | "android-update-on-reconnect";

let off: ReadonlySet<string> = new Set();

export function setPerfOff(names: ReadonlyArray<string>): void {
  off = new Set(names);
}

export function androidPerfOptimizationOn(name: AndroidPerfOptimization): boolean {
  return !off.has(name);
}

export function resetPerfOffForTest(): void {
  off = new Set();
}
