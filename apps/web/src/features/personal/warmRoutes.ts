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
  readonly routesByPath: object;
  /** Undefined when the route's code is already loaded. */
  readonly loadRouteChunk: (route: never) => Promise<unknown> | undefined;
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
 * Once the app is quiet (the same wait as its deferred dialogs), loads the
 * personal screens' code one at a time. Only the route's split chunks: not
 * `preloadRoute`, which also runs route guards and loaders, so a future loader
 * can never fetch data from here. A failure is ignored: it only means that
 * screen is fetched when it is opened, as before. Returns a cancel function.
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
        const route = (router.routesByPath as Record<string, unknown>)[to];
        if (route === undefined) continue;
        try {
          await router.loadRouteChunk(route as never);
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
