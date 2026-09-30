/**
 * Kill switches for performance changes. Every optimization that changes
 * when or how work happens is on by default and can be turned off on one
 * device without a release:
 *
 *   localStorage.setItem("bots:perf-off", "preload-chat")   // comma-separated
 *
 * The perf bench uses the same key to measure each change on and off in one
 * build (scripts/personal/perf/README.md).
 */
export const PERF_OFF_STORAGE_KEY = "bots:perf-off";

export type PerfOptimization =
  | "preload-chat"
  // The chat preload starts from the list's first paint (snapshot included)
  // with a 250 ms idle deadline (1.59.3, H8); off: the 3 s default deadline.
  | "preload-chat-soon"
  // The T3 Connect onboarding wizard mounts only when an in-session sign-in
  // asks for it, keeping its session and link-state reads off boot (1.59.4);
  // off: mounted at boot.
  | "defer-connect-wizard"
  // Root dialogs and hosts that draw nothing at first load after the app has
  // settled (DeferredMount, 1.59.4); off: at once.
  | "lean-boot"
  // A second environment descriptor read within 2 s reuses the first answer
  // (withDescriptorReuse, 1.59.4); off: every read goes to the network.
  | "descriptor-reuse"
  // A chat's mount-time work that the first frame does not need (the keyboard
  // inset's first measurement, the viewing report, the session prewarm) runs
  // after the first paint (afterPaint, 1.59.5); off: in the opening tap.
  | "chat-open-after-paint"
  // Opening a chat paints its header first and mounts the conversation right
  // after that paint (ConversationShellFirst, 1.59.5); off: all in the tap.
  | "chat-shell-first"
  // Client tracing exports every 5 s instead of every second (1.59.5), so a
  // batch does not post during a chat opening; off: every second.
  | "trace-batch"
  | "snapshot-early"
  | "warm-highlighter"
  | "rum"
  | "stale-reload"
  | "lean-shell"
  // Every busy bot on the Bots list animates (1.49.0); off: only the first.
  | "all-busy-motion"
  // Every working bot on the Bots list draws the comet (1.57.3, compositor-only
  // avatars); off: the comet stays on the first working row, as in 1.49 to 1.56.
  | "anim-all"
  // The comet at all (any list, the chat header); off: no comet, poses only.
  | "anim-comet"
  // The thinking pose's thought cloud (1.59.0); off: no cloud, the 1.57.3 pose.
  | "anim-thought";

export function perfOptimizationOn(name: PerfOptimization): boolean {
  try {
    const off = globalThis.localStorage?.getItem(PERF_OFF_STORAGE_KEY);
    if (!off) return true;
    return !off
      .split(",")
      .map((entry) => entry.trim())
      .includes(name);
  } catch {
    return true;
  }
}

/**
 * Runs `work` when the main thread is idle, or after `fallbackMs` where the
 * browser has no requestIdleCallback (iOS Safari). Returns a cancel function.
 */
export function whenIdle(work: () => void, fallbackMs = 1_500): () => void {
  const idle = (
    globalThis as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    }
  ).requestIdleCallback;
  if (typeof idle === "function") {
    const handle = idle(work, { timeout: fallbackMs * 2 });
    return () =>
      (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(work, fallbackMs);
  return () => clearTimeout(handle);
}
