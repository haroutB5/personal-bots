import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COLLAPSE_TIMEOUT_MS,
  RELEASE_DELAY_MS,
  collapseBeforeNavigating,
  createOverlayBack,
  isSentinelState,
  overlayBackSupported,
} from "./overlayBack";

interface Entry {
  url: string;
  state: Record<string, unknown> | null;
}

type PopListener = (event: { stopImmediatePropagation(): void }) => void;
type GestureListener = () => void;

/** A browser history: entries, traversal that fires popstate on a later tick, capture listeners first. */
function createBrowser(firstState: Record<string, unknown> | null = { __TSR_index: 0 }) {
  const entries: Entry[] = [{ url: "/chat", state: firstState }];
  let index = 0;
  const capture: PopListener[] = [];
  const bubble: PopListener[] = [];
  const routerSaw: number[] = [];
  const gestureListeners = new Set<GestureListener>();
  const pending: Array<() => void> = [];
  let traversals = 0;

  const history = {
    get state() {
      return entries[index]?.state ?? null;
    },
    go(delta: number) {
      pending.push(() => {
        const target = Math.max(0, Math.min(entries.length - 1, index + delta));
        if (target === index) return;
        index = target;
        traversals += 1;
        let stopped = false;
        const event = {
          stopImmediatePropagation: () => {
            stopped = true;
          },
        };
        for (const listener of capture) {
          listener(event);
          if (stopped) return;
        }
        for (const listener of bubble) listener(event);
      });
    },
    back() {
      history.go(-1);
    },
  };
  const win = {
    history,
    location: {
      get href() {
        return entries[index]!.url;
      },
    },
    addEventListener(type: string, listener: PopListener | GestureListener, isCapture: boolean) {
      if (type !== "popstate") gestureListeners.add(listener as GestureListener);
      else (isCapture ? capture : bubble).push(listener as PopListener);
    },
    removeEventListener(type: string, listener: PopListener | GestureListener, isCapture: boolean) {
      if (type !== "popstate") {
        gestureListeners.delete(listener as GestureListener);
        return;
      }
      const list = isCapture ? capture : bubble;
      list.splice(list.indexOf(listener as PopListener), 1);
    },
  };
  // What the router does: push a page (never traversal), and note each popstate it receives.
  bubble.push(() => routerSaw.push(index));
  return {
    entries,
    win,
    routerSaw,
    /** How many history traversals the browser has made. */
    get traversals() {
      return traversals;
    },
    get index() {
      return index;
    },
    /** A tap or key press: listeners run while the gesture is fresh. */
    gesture() {
      for (const listener of [...gestureListeners]) listener();
    },
    rawPush(state: unknown, _title: string, url: string) {
      entries.length = index + 1;
      entries.push({ url, state: state as Record<string, unknown> });
      index += 1;
    },
    rawReplace(state: unknown, _title: string, url: string) {
      entries[index] = { url, state: state as Record<string, unknown> };
    },
    routerPush(url: string) {
      entries.length = index + 1;
      entries.push({ url, state: { __TSR_index: index + 1 } });
      index += 1;
    },
    /** Runs queued traversals (each one a later task in a real browser). */
    async settle() {
      while (pending.length > 0) pending.shift()!();
      await Promise.resolve();
      while (pending.length > 0) pending.shift()!();
    },
  };
}

function setup(firstState?: Record<string, unknown> | null) {
  const browser = createBrowser(firstState);
  const fresh = { value: true };
  const timers: Array<{ run: () => void; ms: number }> = [];
  const overlayBack = createOverlayBack(browser.win, {
    pushState: (state, title, url) => browser.rawPush(state, title, url),
    replaceState: (state, title, url) => browser.rawReplace(state, title, url),
    setTimeout: (run, ms) => {
      timers.push({ run, ms });
      return timers.length - 1;
    },
    clearTimeout: (handle) => {
      const timer = timers[handle as number];
      if (timer !== undefined) timer.run = () => undefined;
    },
    gestureIsFresh: () => fresh.value,
  });
  browser.gesture(); // the tap that opens the first overlay
  /** Runs the timers a closed overlay left for its sentinel (a later task in a real browser). */
  const releaseDue = () => {
    for (const timer of timers.filter((entry) => entry.ms === RELEASE_DELAY_MS)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  };
  return { browser, overlayBack, timers, fresh, releaseDue };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Back closes the open overlay", () => {
  it("pops the overlay's entry, closes it, and never tells the router", async () => {
    const { browser, overlayBack } = setup();
    const close = vi.fn();
    overlayBack.register(close);
    expect(browser.entries).toHaveLength(2);

    browser.win.history.back();
    await browser.settle();

    expect(close).toHaveBeenCalledTimes(1);
    expect(browser.index).toBe(0);
    expect(browser.routerSaw).toEqual([]);
  });

  it("closes only the top overlay when two are open", async () => {
    const { browser, overlayBack } = setup();
    const sheet = vi.fn();
    const dialog = vi.fn();
    overlayBack.register(sheet);
    overlayBack.register(dialog);
    expect(browser.entries).toHaveLength(3);

    browser.win.history.back();
    await browser.settle();
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(sheet).not.toHaveBeenCalled();

    browser.win.history.back();
    await browser.settle();
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(browser.routerSaw).toEqual([]);
  });

  it("lets Back through to the router once nothing is open", async () => {
    const { browser, overlayBack } = setup();
    browser.routerPush("/other");
    const close = vi.fn();
    const unregister = overlayBack.register(close);
    unregister();

    // The overlay was closed with a tap: the empty entry is stepped over, and
    // the one step the owner asked for still happens.
    browser.win.history.back();
    await browser.settle();
    expect(close).not.toHaveBeenCalled();
    expect(browser.index).toBe(0);
    expect(browser.routerSaw).toEqual([0]);
  });

  it("reuses the empty entry of a closed overlay instead of piling up entries", async () => {
    const { browser, overlayBack } = setup();
    for (let round = 0; round < 5; round += 1) {
      const unregister = overlayBack.register(() => undefined);
      unregister();
    }
    expect(browser.entries).toHaveLength(2);
  });
});

describe("an overlay closed without Back (Cancel, Esc, a tap outside)", () => {
  it("pops its entry at once, so the next Back at the root is not used up on it", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    const unregister = overlayBack.register(() => undefined);
    expect(browser.entries).toHaveLength(2);
    unregister();
    releaseDue();
    await browser.settle();

    expect(browser.index).toBe(0);
    expect(isSentinelState(browser.win.history.state)).toBe(false);
    expect(browser.routerSaw).toEqual([]);

    // The next Back is the owner's own: nothing left to step over.
    const before = browser.traversals;
    browser.win.history.back();
    await browser.settle();
    expect(browser.traversals).toBe(before);
  });

  it("leaves a chat in one Back after its menu was closed by a tap", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    browser.routerPush("/chat/1");
    browser.gesture();
    const unregister = overlayBack.register(() => undefined);
    unregister();
    releaseDue();
    await browser.settle();
    expect(browser.index).toBe(1);
    expect(isSentinelState(browser.win.history.state)).toBe(false);

    const before = browser.traversals;
    browser.win.history.back();
    await browser.settle();
    expect(browser.traversals).toBe(before + 1);
    expect(browser.index).toBe(0);
    expect(browser.routerSaw).toEqual([0]);
  });

  it("keeps the entry for an overlay that opens in the same tick", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    const unregister = overlayBack.register(() => undefined);
    unregister();
    const close = vi.fn();
    overlayBack.register(close);
    releaseDue();
    await browser.settle();
    expect(browser.entries).toHaveLength(2);
    expect(browser.index).toBe(1);

    browser.win.history.back();
    await browser.settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(browser.routerSaw).toEqual([]);
  });

  it("pops only its own entry when another overlay stays open", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    const sheet = vi.fn();
    overlayBack.register(sheet);
    const unregisterDialog = overlayBack.register(() => undefined);
    expect(browser.index).toBe(2);
    unregisterDialog();
    releaseDue();
    await browser.settle();
    expect(browser.index).toBe(1);

    browser.win.history.back();
    await browser.settle();
    expect(sheet).toHaveBeenCalledTimes(1);
    expect(browser.index).toBe(0);
    expect(browser.routerSaw).toEqual([]);
  });

  it("pops every entry once the last overlay closes, whichever closed first", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    const unregisterSheet = overlayBack.register(() => undefined);
    const unregisterDialog = overlayBack.register(() => undefined);
    unregisterSheet();
    releaseDue();
    await browser.settle();
    expect(browser.index).toBe(2); // the dialog still owns the top entry
    unregisterDialog();
    releaseDue();
    await browser.settle();
    expect(browser.index).toBe(0);
    expect(browser.routerSaw).toEqual([]);
  });

  it("does nothing more when Back itself closed the overlay", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    let unregister = () => {};
    unregister = overlayBack.register(() => unregister());
    browser.win.history.back();
    await browser.settle();
    releaseDue();
    await browser.settle();
    expect(browser.traversals).toBe(1);
    expect(browser.index).toBe(0);
  });

  it("does not pop twice when a navigation is already collapsing the entry", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    const unregister = overlayBack.register(() => undefined);
    const navigate = vi.fn(() => browser.routerPush("/next"));
    overlayBack.afterCollapse(navigate);
    unregister();
    releaseDue();
    await browser.settle();
    expect(browser.traversals).toBe(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(browser.entries.map((entry) => entry.url)).toEqual(["/chat", "/next"]);
  });

  it("gives an overlay that opens during the pop its entry on the next tap", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    const unregister = overlayBack.register(() => undefined);
    unregister();
    releaseDue(); // the pop is under way
    const close = vi.fn();
    overlayBack.register(close);
    await browser.settle();
    expect(browser.entries).toHaveLength(2); // the stale entry is still there, forward
    expect(browser.index).toBe(0);

    browser.gesture();
    expect(browser.index).toBe(1);
    browser.win.history.back();
    await browser.settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(browser.routerSaw).toEqual([]);
  });

  it("cancels the pending pop when the controller is disposed", async () => {
    const { browser, overlayBack, releaseDue } = setup();
    overlayBack.register(() => undefined)();
    overlayBack.dispose();
    releaseDue();
    await browser.settle();
    expect(browser.traversals).toBe(0);
  });
});

describe("an overlay that opens without a fresh gesture", () => {
  it("writes no entry until the next tap, so Chrome does not skip it", async () => {
    const { browser, overlayBack, fresh } = setup();
    fresh.value = false;
    const close = vi.fn();
    overlayBack.register(close);
    expect(browser.entries).toHaveLength(1);

    browser.gesture(); // a gesture event whose activation is not fresh changes nothing
    expect(browser.entries).toHaveLength(1);

    fresh.value = true;
    browser.gesture();
    expect(browser.entries).toHaveLength(2);

    browser.win.history.back();
    await browser.settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(browser.routerSaw).toEqual([]);
  });

  it("treats a gesture from before the last Back as stale", async () => {
    const { browser, overlayBack } = setup();
    browser.routerPush("/team");
    browser.routerPush("/bot");
    // Back lands on /team, which reopens a sheet by itself: no tap since the Back.
    browser.win.history.back();
    await browser.settle();
    const close = vi.fn();
    overlayBack.register(close);
    expect(browser.entries).toHaveLength(3);
    expect(browser.index).toBe(1);

    browser.gesture();
    expect(browser.entries).toHaveLength(3);
    expect(browser.index).toBe(2);

    browser.win.history.back();
    await browser.settle();
    expect(close).toHaveBeenCalledTimes(1);
    expect(browser.index).toBe(1);
  });

  it("writes nothing if the overlay closed before any gesture", () => {
    const { browser, overlayBack, fresh } = setup();
    fresh.value = false;
    const unregister = overlayBack.register(() => undefined);
    unregister();
    fresh.value = true;
    browser.gesture();
    expect(browser.entries).toHaveLength(1);
  });

  it("navigates at once, with nothing to collapse", () => {
    const { overlayBack, fresh } = setup();
    fresh.value = false;
    overlayBack.register(() => undefined);
    const navigate = vi.fn();
    overlayBack.afterCollapse(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

describe("navigating while an overlay entry is on top", () => {
  it("pops it first, so the page lands where it would have without the overlay", async () => {
    const { browser, overlayBack } = setup();
    overlayBack.register(() => undefined);
    const navigate = vi.fn(() => browser.routerPush("/next"));

    overlayBack.afterCollapse(navigate);
    expect(navigate).not.toHaveBeenCalled();
    await browser.settle();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(browser.entries.map((entry) => entry.url)).toEqual(["/chat", "/next"]);
    expect(browser.entries.every((entry) => !("personalOverlayDepth" in (entry.state ?? {})))).toBe(
      true,
    );
    expect(browser.routerSaw).toEqual([]);
  });

  it("runs the navigation at once when nothing is on top", () => {
    const { overlayBack } = setup();
    const navigate = vi.fn();
    overlayBack.afterCollapse(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("queues navigations that arrive mid-collapse, in order", async () => {
    const { browser, overlayBack } = setup();
    overlayBack.register(() => undefined);
    const order: string[] = [];
    overlayBack.afterCollapse(() => order.push("first"));
    overlayBack.afterCollapse(() => order.push("second"));
    await browser.settle();
    expect(order).toEqual(["first", "second"]);
  });

  it("does not wait forever for a pop that never comes", () => {
    const { overlayBack, timers } = setup();
    overlayBack.register(() => undefined);
    const navigate = vi.fn();
    overlayBack.afterCollapse(navigate);
    expect(navigate).not.toHaveBeenCalled();
    expect(timers[0]?.ms).toBe(COLLAPSE_TIMEOUT_MS);
    timers[0]!.run();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("wraps the router history so every way of leaving collapses first", async () => {
    const { browser, overlayBack } = setup();
    const calls: string[] = [];
    const history = collapseBeforeNavigating(
      {
        push: (path: string) => {
          calls.push(`push ${path}`);
          browser.routerPush(path);
        },
        replace: () => calls.push("replace"),
        back: () => calls.push("back"),
        go: () => calls.push("go"),
        forward: () => calls.push("forward"),
      },
      overlayBack,
    );
    overlayBack.register(() => undefined);
    history.push("/next");
    expect(calls).toEqual([]);
    await browser.settle();
    expect(calls).toEqual(["push /next"]);
    history.back();
    expect(calls).toEqual(["push /next", "back"]);
  });
});

describe("a reload on an overlay entry", () => {
  it("drops the flag, so Back is an ordinary Back", () => {
    const { browser } = setup({ __TSR_index: 3, personalOverlayDepth: 1 });
    expect(browser.win.history.state).toEqual({ __TSR_index: 3 });
  });
});

describe("where it is switched on", () => {
  it("is for touch devices that are not iOS", () => {
    expect(overlayBackSupported({ coarsePointer: true, hasNavigatorStandalone: false })).toBe(true);
    expect(overlayBackSupported({ coarsePointer: true, hasNavigatorStandalone: true })).toBe(false);
    expect(overlayBackSupported({ coarsePointer: false, hasNavigatorStandalone: false })).toBe(
      false,
    );
  });
});
