import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { PERF_OFF_STORAGE_KEY } from "./perfFlags";
import { warmPersonalRoutes, WARM_ROUTES } from "./warmRoutes";

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

afterEach(() => vi.unstubAllGlobals());

describe("warming the personal screens", () => {
  it("preloads every screen, one at a time, once the app is quiet", async () => {
    const seen: string[] = [];
    let inFlight = 0;
    let overlap = false;
    const router = {
      preloadRoute: async ({ to }: { to: string }) => {
        inFlight += 1;
        overlap ||= inFlight > 1;
        await flush();
        seen.push(to);
        inFlight -= 1;
      },
    };
    const world = deps();
    warmPersonalRoutes(router, world.deps);
    expect(seen).toEqual([]);
    world.quiet();
    await vi.waitFor(() => expect(seen).toEqual([...WARM_ROUTES]));
    expect(overlap).toBe(false);
  });

  it("stops when the network goes, and never starts on data saver", async () => {
    const preloadRoute = vi.fn(async () => undefined);
    let online = true;
    const world = deps({ online: () => online });
    warmPersonalRoutes({ preloadRoute }, world.deps);
    online = false;
    world.quiet();
    await flush();
    expect(preloadRoute).not.toHaveBeenCalled();

    const saver = deps({ saveData: () => true });
    warmPersonalRoutes({ preloadRoute }, saver.deps);
    saver.quiet();
    await flush();
    expect(preloadRoute).not.toHaveBeenCalled();
  });

  it("a screen that fails to preload does not stop the others", async () => {
    const seen: string[] = [];
    const router = {
      preloadRoute: async ({ to }: { to: string }) => {
        seen.push(to);
        if (to === "/bots/team") throw new TypeError("Failed to fetch dynamically imported module");
      },
    };
    const world = deps();
    warmPersonalRoutes(router, world.deps);
    world.quiet();
    await vi.waitFor(() => expect(seen).toEqual([...WARM_ROUTES]));
  });

  it("cancelling stops the wait and the loop", async () => {
    const preloadRoute = vi.fn(async () => undefined);
    const world = deps();
    const cancel = warmPersonalRoutes({ preloadRoute }, world.deps);
    cancel();
    expect(world.stop).toHaveBeenCalledTimes(1);
    world.quiet();
    await flush();
    expect(preloadRoute).not.toHaveBeenCalled();
  });

  it("the kill switch leaves everything to be fetched on demand", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === PERF_OFF_STORAGE_KEY ? "warm-routes" : null),
    });
    const whenQuiet = vi.fn(() => () => undefined);
    warmPersonalRoutes(
      { preloadRoute: async () => undefined },
      { isOnline: () => true, saveData: () => false, whenQuiet },
    );
    expect(whenQuiet).not.toHaveBeenCalled();
  });
});
