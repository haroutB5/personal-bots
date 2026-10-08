import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ChunkRecoveryEnv,
  createChunkRecovery,
  probeServerReachable,
} from "./chunkLoadRecovery";
import { isChunkLoadError } from "./chunkLoadError";

/** A recovery over a fake browser: the test decides what the network and the server do. */
function setup(initial: { online?: boolean; reachable?: boolean; reloadTried?: boolean } = {}) {
  const world = {
    online: initial.online ?? true,
    reachable: initial.reachable ?? true,
    reloadTried: initial.reloadTried ?? false,
    reloads: 0,
    probes: 0,
    check: null as null | (() => void),
    watching: 0,
  };
  const env: ChunkRecoveryEnv = {
    isOnline: () => world.online,
    probe: async () => {
      world.probes += 1;
      return world.reachable;
    },
    reloadAlreadyTried: () => world.reloadTried,
    reloadOnce: () => {
      if (world.reloadTried) return false;
      world.reloadTried = true;
      world.reloads += 1;
      return true;
    },
    watchConnection: (check) => {
      world.check = check;
      world.watching += 1;
      return () => {
        world.watching -= 1;
        world.check = null;
      };
    },
  };
  return { world, recovery: createChunkRecovery(env) };
}

describe("a chunk that fails to load", () => {
  it("reloads once when the server answers: the hashed assets are stale after a deploy", async () => {
    const { world, recovery } = setup();
    const outcome = recovery.onPreloadError();
    expect(outcome.kind).toBe("check");
    if (outcome.kind !== "check") return;
    await expect(outcome.settled).resolves.toBe("reloaded");
    expect(world.reloads).toBe(1);
    // A second failure of the same streak does not reload again: it surfaces.
    expect(recovery.onPreloadError().kind).toBe("surface");
    expect(world.reloads).toBe(1);
  });

  it("does not reload when the phone has no network, and does not even ask the server", () => {
    const { world, recovery } = setup({ online: false });
    expect(recovery.onPreloadError().kind).toBe("away");
    expect(world.reloads).toBe(0);
    expect(world.probes).toBe(0);
  });

  it("does not reload when the network is up but the server does not answer (laptop asleep, tunnel down)", async () => {
    const { world, recovery } = setup({ reachable: false });
    const outcome = recovery.onPreloadError();
    expect(outcome.kind).toBe("check");
    if (outcome.kind !== "check") return;
    await expect(outcome.settled).resolves.toBe("away");
    expect(world.reloads).toBe(0);
    expect(world.reloadTried).toBe(false);
  });

  it("holds the first paint until the server has been asked, then lets it through", async () => {
    const { recovery } = setup();
    const outcome = recovery.onPreloadError();
    let idle = false;
    void recovery.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    if (outcome.kind === "check") await outcome.settled;
    await recovery.idle();
    expect(idle).toBe(true);
  });

  it("is idle at once when nothing failed", async () => {
    const { recovery } = setup();
    await expect(recovery.idle()).resolves.toBeUndefined();
  });
});

describe("away", () => {
  it("is true with no network, while a check is out, and for a minute after a failed one", async () => {
    vi.useFakeTimers();
    try {
      const { world, recovery } = setup({ reachable: false });
      expect(recovery.away()).toBe(false);
      const outcome = recovery.onPreloadError();
      expect(recovery.away()).toBe(true); // the check is out
      if (outcome.kind === "check") await outcome.settled;
      expect(recovery.away()).toBe(true); // it failed a moment ago
      await vi.advanceTimersByTimeAsync(61_000);
      expect(recovery.away()).toBe(false);
      world.online = false;
      expect(recovery.away()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is false again once a check finds the server", async () => {
    const { recovery } = setup({ reachable: true });
    const outcome = recovery.onPreloadError();
    if (outcome.kind === "check") await outcome.settled;
    expect(recovery.away()).toBe(false);
  });
});

describe("waiting for the server to come back", () => {
  it("runs the callback once the server answers, and stops watching", async () => {
    const { world, recovery } = setup({ online: false, reachable: false });
    const back = vi.fn();
    recovery.whenServerBack(back);
    expect(world.watching).toBe(1);
    world.check?.();
    await vi.waitFor(() => expect(world.probes).toBe(1));
    expect(back).not.toHaveBeenCalled();

    world.online = true;
    world.reachable = true;
    world.check?.();
    await vi.waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    expect(world.watching).toBe(0);
  });

  it("does not call a callback that was cancelled", async () => {
    const { world, recovery } = setup({ online: false, reachable: true });
    const back = vi.fn();
    const stop = recovery.whenServerBack(back);
    stop();
    expect(world.watching).toBe(0);
    expect(back).not.toHaveBeenCalled();
  });

  it("asks one question at a time; a change while one is out asks once more, not once per event", async () => {
    const { world, recovery } = setup({ online: false, reachable: false });
    recovery.whenServerBack(() => undefined);
    world.check?.();
    world.check?.();
    world.check?.();
    await vi.waitFor(() => expect(world.probes).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(world.probes).toBe(2);
  });
});

describe("probeServerReachable", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is true for a good answer from /version.txt, uncached", async () => {
    const fetchImpl = vi.fn(async () => new Response("version=1", { status: 200 }));
    await expect(probeServerReachable(fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/version.txt",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("is false for a server error, a network failure and a hang", async () => {
    await expect(
      probeServerReachable((async () => new Response("", { status: 502 })) as typeof fetch),
    ).resolves.toBe(false);
    await expect(
      probeServerReachable((async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch),
    ).resolves.toBe(false);
    const hung = probeServerReachable(
      ((_: RequestInfo | URL, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
        })) as typeof fetch,
      1_000,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(hung).resolves.toBe(false);
  });
});

describe("isChunkLoadError", () => {
  it("knows the three engines' messages and Vite's CSS one", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: https://x/assets/a-1.js",
      "Importing a module script failed.",
      "error loading dynamically imported module: https://x/assets/a-1.js",
      "Unable to preload CSS for /assets/a.css",
    ]) {
      expect(isChunkLoadError(new TypeError(message))).toBe(true);
    }
    expect(
      isChunkLoadError(
        new Error("wrapper", { cause: new TypeError("Importing a module script failed.") }),
      ),
    ).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isChunkLoadError(new Error("x is not a function"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});
