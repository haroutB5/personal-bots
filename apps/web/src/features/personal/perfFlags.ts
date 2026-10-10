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
  // The phone keeps the Bots list mounted (hidden, React Activity) under the
  // pages opened from it, so a tap hides it and Back shows it at its scroll
  // position (keptBotsList.ts, 1.60.0); off: every tap unmounts it and Back
  // mounts it again.
  | "keep-list"
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
  | "anim-thought"
  // The shared-browser live view reports frame, decode and tap-to-paint timings
  // to the server log every 5 s while it is open (1.60.33); off: it reports none.
  | "stream-telemetry"
  // A finger drag on the shared browser sends one summed scroll step per animation
  // frame (wheelBatcher.ts, 1.60.34); off: one per touch move, as before.
  | "wheel-batch"
  // The Bots list reads each chat's activity time once per rebuild and keeps it
  // per shell (chatActivity.ts memo, botSummaries newestFirst, 1.64.1); off:
  // parsed again inside every sort comparison, as before.
  | "activity-memo"
  // The team constellation measures each candidate layout once while ordering
  // them (1.64.1); off: twice per comparison, as before.
  | "layout-once"
  // A launch on a Bots path boots without the Clerk (T3 Connect sign-in) shell:
  // no Clerk chunk, no cross-origin Clerk scripts or calls (cloud/managedAuthBoot,
  // 1.67.0); off: Clerk loads on every launch, as before.
  | "skip-clerk"
  // Once the app is quiet it preloads the personal screens' code (Team, Settings,
  // Memory, Files, Tasks, Computer) so they still open when the phone loses its
  // network (warmRoutes.ts, 1.66.11); off: each is fetched when first opened.
  | "warm-routes"
  // A re-pin the composer's own growth caused (a typed line) glides to the new
  // bottom over 120ms instead of one instant write, so the transcript stops
  // jumping while typing on the phone (MessageList.tsx, 1.66.23); off: one
  // instant write, as before.
  | "resize-pin-tween";

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
