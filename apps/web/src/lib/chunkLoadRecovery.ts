import { peekChunkReloadGuard, reloadOnceForChunkLoadError } from "./chunkReloadGuard";

/**
 * What a failed split-chunk fetch does (`vite:preloadError`), 1.66.11.
 *
 * Two different things make a chunk fail:
 *  - the hashed assets went stale under a deploy: the server answers, with a
 *    404 or the new index.html. One guarded reload picks up the new release.
 *  - the phone has no network (a tube, a lift) or the laptop cannot be reached:
 *    nothing answers. A reload then boots the saved shell with no way to sign
 *    in and lands on the root "Laptop offline" screen, taking a chat the owner
 *    was typing in with it.
 *
 * The server's own answer tells them apart. `/version.txt` is never cached by
 * the service worker, so a good answer means the server is up and the chunk
 * is stale (reload as before); no answer, or a bad one, means away: stay on
 * the screen, and wait for the connection before anything is done about it.
 */

/** A probe that takes longer than this counts as no answer. */
export const CHUNK_PROBE_TIMEOUT_MS = 5_000;
/** While away, how often the server is asked again (the `online` event is quicker when it fires). */
export const CHUNK_AWAY_POLL_MS = 5_000;

/** True when the server answered `/version.txt` with a good response. */
export async function probeServerReachable(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  timeoutMs = CHUNK_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("/version.txt", {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface ChunkRecoveryEnv {
  /** `navigator.onLine`: false is proof of no network; true proves nothing. */
  readonly isOnline: () => boolean;
  /** True when the server answers well (probeServerReachable). */
  readonly probe: () => Promise<boolean>;
  /** The loop guard: has this failure streak already had its one reload? */
  readonly reloadAlreadyTried: () => boolean;
  /** The one guarded reload. Returns whether it reloaded. */
  readonly reloadOnce: () => boolean;
  /** Calls back whenever the connection might be back; returns the stop function. */
  readonly watchConnection: (check: () => void) => () => void;
}

export type ChunkErrorOutcome =
  /** No network: leave the failure to its importer, reload nothing, wait for the server. */
  | { readonly kind: "away" }
  /** The loop guard is spent: let the error surface through the normal paths. */
  | { readonly kind: "surface" }
  /**
   * The network may be up: a reload is on its way unless the server turns out
   * to be unreachable. `settled` says which; the caller holds the reload
   * flag (and any first paint) until it does.
   */
  | { readonly kind: "check"; readonly settled: Promise<"reloaded" | "away"> };

export interface ChunkRecovery {
  /** The decision for one `vite:preloadError`. Never throws. */
  readonly onPreloadError: () => ChunkErrorOutcome;
  /** Resolves once no connection check is running. */
  readonly idle: () => Promise<void>;
  /** Runs `callback` once the server answers again (immediately when a probe already succeeds). */
  readonly whenServerBack: (callback: () => void) => () => void;
}

export function createChunkRecovery(env: ChunkRecoveryEnv): ChunkRecovery {
  let pending = 0;
  let idleWaiters: Array<() => void> = [];
  const waitingCallbacks = new Set<() => void>();
  let stopWatching: (() => void) | null = null;
  let probing = false;
  let askAgain = false;

  const settle = () => {
    pending -= 1;
    if (pending > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  };

  const checkBack = () => {
    if (waitingCallbacks.size === 0) return;
    if (probing) {
      // The connection changed while a question was out: its answer may be stale.
      askAgain = true;
      return;
    }
    probing = true;
    askAgain = false;
    void env
      .probe()
      .catch(() => false)
      .then((reachable) => {
        probing = false;
        if (waitingCallbacks.size === 0) return;
        if (!reachable) {
          if (askAgain) checkBack();
          return;
        }
        const callbacks = [...waitingCallbacks];
        waitingCallbacks.clear();
        stopWatching?.();
        stopWatching = null;
        for (const callback of callbacks) callback();
      });
  };

  const whenServerBack = (callback: () => void): (() => void) => {
    waitingCallbacks.add(callback);
    stopWatching ??= env.watchConnection(checkBack);
    // The connection may already be back (a probe failed a moment ago on a blip).
    if (env.isOnline()) checkBack();
    return () => {
      waitingCallbacks.delete(callback);
      if (waitingCallbacks.size === 0) {
        stopWatching?.();
        stopWatching = null;
      }
    };
  };

  const onPreloadError = (): ChunkErrorOutcome => {
    if (!env.isOnline()) return { kind: "away" };
    if (env.reloadAlreadyTried()) return { kind: "surface" };
    pending += 1;
    const settled = env
      .probe()
      .catch(() => false)
      .then((reachable): "reloaded" | "away" => {
        if (!reachable) return "away";
        return env.reloadOnce() ? "reloaded" : "away";
      })
      .finally(settle);
    return { kind: "check", settled };
  };

  return {
    onPreloadError,
    idle: () =>
      pending === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve)),
    whenServerBack,
  };
}

/** The browser's recovery: navigator, `/version.txt`, sessionStorage guard, `online` / visibility events, a slow poll. */
export function browserChunkRecoveryEnv(): ChunkRecoveryEnv {
  return {
    isOnline: () => navigator.onLine !== false,
    probe: () => probeServerReachable(),
    reloadAlreadyTried: () => peekChunkReloadGuard(),
    reloadOnce: () => reloadOnceForChunkLoadError(),
    watchConnection: (check) => {
      const onVisible = () => {
        if (document.visibilityState === "visible") check();
      };
      window.addEventListener("online", check);
      document.addEventListener("visibilitychange", onVisible);
      const timer = window.setInterval(check, CHUNK_AWAY_POLL_MS);
      return () => {
        window.removeEventListener("online", check);
        document.removeEventListener("visibilitychange", onVisible);
        window.clearInterval(timer);
      };
    },
  };
}

let shared: ChunkRecovery | null = null;

/** The page's one recovery, so the boot listener and the error screens agree. */
export function chunkRecovery(): ChunkRecovery {
  return (shared ??= createChunkRecovery(browserChunkRecoveryEnv()));
}
