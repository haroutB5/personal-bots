import { whenQuiet } from "~/lib/DeferredMount";

import { perfOptimizationOn } from "./perfFlags";

/**
 * The screens a phone may need after it loses its network: each one's code is
 * a separate chunk, saved by the service worker only once something fetched it.
 * Fetching them while the connection is good means Team, Memory, Files and the
 * rest still open in a tube. (The Bots list and the chat are in the first load.)
 */
export const WARM_ROUTES = [
  "/bots/team",
  "/bots/settings",
  "/bots/settings/memory",
  "/files",
  "/tasks",
  "/computer",
] as const;

export interface RoutePreloader {
  readonly preloadRoute: (options: { readonly to: string }) => Promise<unknown>;
}

interface WarmDeps {
  readonly isOnline: () => boolean;
  /** "Data saver" asked for: leave the fetch alone. */
  readonly saveData: () => boolean;
  readonly whenQuiet: (work: () => void) => () => void;
}

const browserDeps: WarmDeps = {
  isOnline: () => navigator.onLine !== false,
  saveData: () =>
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
    true,
  whenQuiet,
};

/**
 * Once the app is quiet (the same wait as its deferred dialogs), preloads the
 * personal screens one at a time. A failure is ignored: it only means that screen
 * is fetched when it is opened, as before. Returns a cancel function.
 * Kill switch: bots:perf-off = "warm-routes".
 */
export function warmPersonalRoutes(
  router: RoutePreloader,
  deps: WarmDeps = browserDeps,
): () => void {
  if (!perfOptimizationOn("warm-routes")) return () => undefined;
  let cancelled = false;
  const stopWaiting = deps.whenQuiet(() => {
    void (async () => {
      for (const to of WARM_ROUTES) {
        if (cancelled || !deps.isOnline() || deps.saveData()) return;
        try {
          await router.preloadRoute({ to });
        } catch {
          // Opened (and fetched) on demand instead.
        }
      }
    })();
  });
  return () => {
    cancelled = true;
    stopWaiting();
  };
}
