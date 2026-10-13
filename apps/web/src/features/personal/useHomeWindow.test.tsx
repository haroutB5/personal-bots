import type { RefObject } from "react";
import { useState } from "react";

import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { HomeWindowRange } from "./homeWindow";
import { findScrollParent, useHomeWindow } from "./useHomeWindow";

/**
 * The hook's DOM half, against a hand-made element graph: react-test-renderer
 * host instances have no geometry, so the test hands the hook a fake list and
 * its fake scroller (`ReactTestInstance` has no `parentElement`, which is
 * exactly the no-layout path the hook guards).
 */

interface FakeRect {
  readonly top: number;
  readonly width: number;
}

function rect(top: number, width = 390): FakeRect {
  return { top, width };
}

function fakeScroller(clientHeight: number) {
  const listeners = new Map<string, Array<() => void>>();
  const element = {
    clientHeight,
    top: 0,
    getBoundingClientRect: () => ({ top: element.top }),
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== fn),
      );
    },
  };
  return {
    element,
    fire: (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    listenerCount: () => [...listeners.values()].reduce((sum, fns) => sum + fns.length, 0),
  };
}

type FakeScroller = ReturnType<typeof fakeScroller>;

function fakeList(
  scroller: FakeScroller,
  options: { readonly top?: number; readonly width?: number } = {},
) {
  const state = { top: options.top ?? 0, width: options.width ?? 390 };
  const list: {
    parentElement: unknown;
    getBoundingClientRect: () => FakeRect;
    querySelectorAll: (selector: string) => Array<{ getBoundingClientRect: () => FakeRect }>;
  } = {
    parentElement: scroller.element,
    getBoundingClientRect: () => rect(state.top, state.width),
    // Two drawn rows 72 px apart: the pitch the hook learns.
    querySelectorAll: (selector: string) =>
      selector === "li > .home-row"
        ? [
            { getBoundingClientRect: () => rect(state.top, 342) },
            { getBoundingClientRect: () => rect(state.top + 72, 342) },
          ]
        : [],
  };
  return { list, state };
}

const rafQueue: FrameRequestCallback[] = [];

function stubWindow(scroller: FakeScroller): void {
  vi.stubGlobal("window", {
    getComputedStyle: (node: unknown) => ({
      overflowY: node === scroller.element ? "auto" : "visible",
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    },
    cancelAnimationFrame: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

interface Harness {
  readonly renderer: ReactTestRenderer;
  readonly ranges: HomeWindowRange[];
  /** The scroller the stub's `getComputedStyle` knows: build the fake list on this one. */
  readonly scroller: FakeScroller;
  fakeList(options?: {
    readonly top?: number;
    readonly width?: number;
  }): ReturnType<typeof fakeList>;
  setList(element: unknown): Promise<void>;
  setActive(active: boolean): Promise<void>;
  setCount(count: number): Promise<void>;
  flushRaf(): Promise<void>;
  listRef(): RefObject<HTMLUListElement | null>;
}

async function mount(count: number, active = true): Promise<Harness> {
  const scroller = fakeScroller(600);
  stubWindow(scroller);
  const ranges: HomeWindowRange[] = [];
  let setActive!: (value: boolean) => void;
  let setCount!: (value: number | ((current: number) => number)) => void;
  let bump!: () => void;
  let ref: RefObject<HTMLUListElement | null> = { current: null };
  function Probe() {
    const [activeNow, setA] = useState(active);
    const [countNow, setC] = useState(count);
    const [tick, setTick] = useState(0);
    setActive = setA;
    setCount = setC;
    bump = () => setTick(tick + 1);
    const win = useHomeWindow(countNow, { active: activeNow });
    ref = win.listRef;
    ranges.push(win.range);
    return null;
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Probe />);
  });
  const rerender = async (fn: () => void) => {
    await act(async () => {
      fn();
    });
  };
  return {
    renderer,
    ranges,
    scroller,
    fakeList: (options) => fakeList(scroller, options),
    // The ref is only readable after mount (in the app the list is the same
    // commit): hand the hook the fake, then re-render as a data change would
    // (a count change is also what rebinds the hook's scroll listeners).
    setList: async (element) => {
      ref.current = element as HTMLUListElement;
      await rerender(() => bump());
      await rerender(() => setCount((current) => current + 1));
      await rerender(() => setCount((current) => current - 1));
    },
    setActive: (value) => rerender(() => setActive(value)),
    setCount: (value) => rerender(() => setCount(value)),
    flushRaf: async () => {
      const queue = rafQueue.splice(0);
      await act(async () => {
        for (const callback of queue) callback(0);
      });
    },
    listRef: () => ref,
  };
}

afterEach(() => {
  rafQueue.length = 0;
  vi.unstubAllGlobals();
});

describe("useHomeWindow", () => {
  it("draws a first-paint slice with no layout at all (test renderer)", async () => {
    const harness = await mount(60);
    expect(harness.ranges.at(-1)).toEqual({ start: 0, end: 24 });
    await act(async () => harness.renderer.unmount());
  });

  it("windows the list to the visible band once the layout is readable", async () => {
    const harness = await mount(61);
    const scroller = harness.scroller;
    const { list } = harness.fakeList();
    await harness.setList(list);
    // 600 px of viewport shows 9 rows; 8 rows of band either side; the list
    // sits at the scroller's top, so nothing is above it.
    expect(harness.ranges.at(-1)).toEqual({ start: 0, end: 17 });
    await act(async () => harness.renderer.unmount());
  });

  it("follows a scroll, re-anchoring with the band towards it", async () => {
    const harness = await mount(61);
    const scroller = harness.scroller;
    const { list, state } = harness.fakeList();
    await harness.setList(list);
    expect(scroller.listenerCount()).toBeGreaterThan(0);
    state.top = -720; // the list has moved 720 px up the scroller
    await act(async () => {
      scroller.fire("scroll");
    });
    await harness.flushRaf();
    // Scrolled down: the band stays wide below (12 rows) and slim above (4).
    expect(harness.ranges.at(-1)).toEqual({ start: 6, end: 31 });
    await act(async () => harness.renderer.unmount());
  });

  it("keeps the slice while the list is hidden under an open chat", async () => {
    const harness = await mount(61);
    const scroller = harness.scroller;
    const { list, state } = harness.fakeList();
    await harness.setList(list);
    state.top = -720;
    await act(async () => {
      scroller.fire("scroll");
    });
    await harness.flushRaf();
    const scrolled = harness.ranges.at(-1)!;
    // display: none reads as zero width: the slice must stay where Back will
    // restore the scroll.
    state.width = 0;
    await harness.setActive(false);
    state.top = 0;
    await act(async () => {
      scroller.fire("scroll");
    });
    await harness.flushRaf();
    expect(harness.ranges.at(-1)).toEqual(scrolled);
    await act(async () => harness.renderer.unmount());
  });

  it("corrects a stale slice on the frame after Back", async () => {
    const harness = await mount(61);
    const scroller = harness.scroller;
    const { list, state } = harness.fakeList();
    await harness.setList(list);
    await harness.setActive(false);
    // The scroll moved while hidden (the shell restores it on Back).
    state.top = -1440;
    await harness.setActive(true);
    expect(harness.ranges.at(-1)).toEqual({ start: 0, end: 17 });
    await harness.flushRaf();
    expect(harness.ranges.at(-1)).toEqual({ start: 16, end: 41 });
    await act(async () => harness.renderer.unmount());
  });

  it("clamps a slice the list has outgrown (a filter, a search)", async () => {
    const harness = await mount(61);
    const scroller = harness.scroller;
    const { list, state } = harness.fakeList();
    await harness.setList(list);
    state.top = -1440;
    await act(async () => {
      scroller.fire("scroll");
    });
    await harness.flushRaf();
    expect(harness.ranges.at(-1)!.start).toBe(16);
    await harness.setCount(10);
    const clamped = harness.ranges.at(-1)!;
    expect(clamped.end).toBeLessThanOrEqual(10);
    expect(clamped.start).toBeLessThan(clamped.end);
    await act(async () => harness.renderer.unmount());
  });
});

describe("findScrollParent", () => {
  it("finds the nearest vertical scroller up the tree", () => {
    const scroller = fakeScroller(600);
    const { list } = fakeList(scroller);
    stubWindow(scroller);
    expect(findScrollParent(list as unknown as Element)).toBe(scroller.element);
  });

  it("answers null where there is no DOM (test renderer host instances)", async () => {
    const harness = await mount(5);
    expect(findScrollParent(harness.listRef().current)).toBeNull();
    await act(async () => harness.renderer.unmount());
  });
});
