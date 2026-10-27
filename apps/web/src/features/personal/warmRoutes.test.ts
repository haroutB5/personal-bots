import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PERF_OFF_STORAGE_KEY } from "./perfFlags";
import { afterPaintWhenQuiet, warmPersonalRoutes, WARM_ROUTES } from "./warmRoutes";

function deps(overrides: { online?: () => boolean; saveData?: () => boolean } = {}) {
  let run: (() => void) | null = null;
  const stop = vi.fn();
  return {
    deps: {
      isOnline: overrides.online ?? (() => true),
      saveData: overrides.saveData ?? (() => false),
      whenQuiet: (work: () => void) => {
        run = work;
        return stop;
      },
    },
    quiet: () => run?.(),
    stop,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A router that only knows how to load a route's code: it has no preloadRoute, so a loader or guard cannot run. */
function chunkRouter(loadRouteChunk: (route: never) => Promise<unknown> | undefined) {
  const routesByPath = Object.fromEntries(WARM_ROUTES.map((to) => [to, { path: to }]));
  return { routesByPath, loadRouteChunk };
}

afterEach(() => vi.unstubAllGlobals());

describe("warming the personal screens", () => {
  it("waits for a painted frame before starting the quiet wait, and can cancel it", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++next, callback);
      return next;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const work = vi.fn();
    const cancel = afterPaintWhenQuiet(work);
    expect(frames.size).toBe(1);
    frames.get(1)?.(0);
    frames.delete(1);
    expect(work).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    cancel();
    expect(frames.size).toBe(0);
    expect(work).not.toHaveBeenCalled();
  });

  it("warms only after paint and the quiet and idle waits", () => {
    vi.useFakeTimers();
    try {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      vi.stubGlobal("cancelAnimationFrame", () => undefined);
      vi.stubGlobal("window", {
        setTimeout,
        clearTimeout,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      });
      const work = vi.fn();
      const cancel = afterPaintWhenQuiet(work);
      vi.advanceTimersByTime(20_000);
      expect(work).not.toHaveBeenCalled();
      frames.shift()?.(0);
      frames.shift()?.(0);
      vi.advanceTimersByTime(7_999);
      expect(work).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(work).toHaveBeenCalledOnce();
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preloads every screen, one at a time, once the app is quiet", async () => {
    const seen: string[] = [];
    let inFlight = 0;
    let overlap = false;
    const router = chunkRouter(async (route) => {
      inFlight += 1;
      overlap ||= inFlight > 1;
      await flush();
      seen.push((route as { path: string }).path);
      inFlight -= 1;
    });
    const world = deps();
    warmPersonalRoutes(router, world.deps);
    expect(seen).toEqual([]);
    world.quiet();
    await vi.waitFor(() => expect(seen).toEqual([...WARM_ROUTES]));
    expect(overlap).toBe(false);
  });

  it("loads code chunks only: no guard or loader runs, and an unknown path or an already loaded route is skipped", async () => {
    const routes: Record<string, unknown> = {
      "/bots/team": { path: "/bots/team" },
      "/files": { path: "/files" },
    };
    const loadRouteChunk = vi.fn((route: never) =>
      (route as { path: string }).path === "/files" ? undefined : Promise.resolve(),
    );
    // preloadRoute is the call that runs beforeLoad and loaders; it must never be reached.
    const router = {
      routesByPath: routes,
      loadRouteChunk,
      preloadRoute: vi.fn(async () => undefined),
      loadMatches: vi.fn(),
    };
    const world = deps();
    warmPersonalRoutes(router, world.deps);
    world.quiet();
    await vi.waitFor(() => expect(loadRouteChunk).toHaveBeenCalledTimes(2));
    expect(loadRouteChunk.mock.calls.map(([route]) => (route as { path: string }).path)).toEqual([
      "/bots/team",
      "/files",
    ]);
    expect(router.preloadRoute).not.toHaveBeenCalled();
    expect(router.loadMatches).not.toHaveBeenCalled();
  });

  it("stops when the network goes, and never starts on data saver", async () => {
    const loadRouteChunk = vi.fn(async () => undefined);
    let online = true;
    const world = deps({ online: () => online });
    warmPersonalRoutes(chunkRouter(loadRouteChunk), world.deps);
    online = false;
    world.quiet();
    await flush();
    expect(loadRouteChunk).not.toHaveBeenCalled();

    const saver = deps({ saveData: () => true });
    warmPersonalRoutes(chunkRouter(loadRouteChunk), saver.deps);
    saver.quiet();
    await flush();
    expect(loadRouteChunk).not.toHaveBeenCalled();
  });

  it("a screen that fails to preload does not stop the others", async () => {
    const seen: string[] = [];
    const router = chunkRouter(async (route) => {
      const to = (route as { path: string }).path;
      seen.push(to);
      if (to === "/bots/team") throw new TypeError("Failed to fetch dynamically imported module");
    });
    const world = deps();
    warmPersonalRoutes(router, world.deps);
    world.quiet();
    await vi.waitFor(() => expect(seen).toEqual([...WARM_ROUTES]));
  });

  it("cancelling stops the wait and the loop", async () => {
    const loadRouteChunk = vi.fn(async () => undefined);
    const world = deps();
    const cancel = warmPersonalRoutes(chunkRouter(loadRouteChunk), world.deps);
    cancel();
    expect(world.stop).toHaveBeenCalledTimes(1);
    world.quiet();
    await flush();
    expect(loadRouteChunk).not.toHaveBeenCalled();
  });

  it("the kill switch leaves everything to be fetched on demand", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === PERF_OFF_STORAGE_KEY ? "warm-routes" : null),
    });
    const whenQuiet = vi.fn(() => () => undefined);
    warmPersonalRoutes(
      chunkRouter(async () => undefined),
      { isOnline: () => true, saveData: () => false, whenQuiet },
    );
    expect(whenQuiet).not.toHaveBeenCalled();
  });
});
