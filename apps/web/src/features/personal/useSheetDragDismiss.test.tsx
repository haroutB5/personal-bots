import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

import {
  DISMISS_FRACTION,
  FLICK_MIN_PX,
  FLICK_PX_PER_MS,
  releaseVelocity,
  sheetDragMayStart,
  shouldDismissSheetDrag,
  useSheetDragDismiss,
} from "./useSheetDragDismiss";

/** A tiny element tree: enough of the DOM for the hook, with no browser environment. */
class FakeEl {
  parentElement: FakeEl | null = null;
  scrollTop = 0;
  readonly children: FakeEl[] = [];
  readonly style: Record<string, string> = {};
  readonly attrs = new Set<string>();
  isConnected = true;
  rectHeight = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(
    readonly id: string,
    attrs: readonly string[] = [],
    parent: FakeEl | null = null,
  ) {
    for (const attr of attrs) this.attrs.add(attr);
    this.parentElement = parent;
    parent?.children.push(this);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  closest(selector: string): FakeEl | null {
    const attr = selector.slice(1, -1);
    for (let node: FakeEl | null = this; node !== null; node = node.parentElement) {
      if (node.attrs.has(attr)) return node;
    }
    return null;
  }
  contains(other: unknown): boolean {
    for (let node = other as FakeEl | null; node; node = node.parentElement) {
      if (node === this) return true;
    }
    return false;
  }
  getBoundingClientRect() {
    return { height: this.rectHeight };
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
    );
  }
  /** Bubbles the event up the tree like the browser does. */
  dispatch(type: string, event: object) {
    for (let node: FakeEl | null = this; node !== null; node = node.parentElement) {
      for (const listener of node.listeners.get(type) ?? []) listener(event);
    }
  }
}

/** sheet > [zone > close] [body > [text, lock(no-drag) > lockInner, tap]] */
function buildTree() {
  const sheet = new FakeEl("sheet", ["data-open"]);
  const zone = new FakeEl("zone", ["data-sheet-drag-zone"], sheet);
  const close = new FakeEl("close", [], zone);
  const body = new FakeEl("body", [], sheet);
  const text = new FakeEl("text", [], body);
  const lock = new FakeEl("lock", ["data-sheet-no-drag"], body);
  const lockInner = new FakeEl("lockInner", [], lock);
  const tap = new FakeEl("tap", [], body);
  return { sheet, zone, close, body, text, lock, lockInner, tap };
}

describe("shouldDismissSheetDrag", () => {
  const height = 400;
  it("dismisses at a quarter of the sheet's height, not before", () => {
    const edge = height * DISMISS_FRACTION;
    expect(shouldDismissSheetDrag({ offset: edge - 1, height, velocity: 0 })).toBe(false);
    expect(shouldDismissSheetDrag({ offset: edge, height, velocity: 0 })).toBe(true);
    expect(shouldDismissSheetDrag({ offset: height, height, velocity: 0 })).toBe(true);
  });

  it("dismisses a quick downward flick that travelled a little", () => {
    expect(shouldDismissSheetDrag({ offset: 40, height, velocity: FLICK_PX_PER_MS })).toBe(true);
    expect(shouldDismissSheetDrag({ offset: 40, height, velocity: FLICK_PX_PER_MS - 0.01 })).toBe(
      false,
    );
  });

  it("does not let a twitch close the sheet", () => {
    expect(shouldDismissSheetDrag({ offset: FLICK_MIN_PX - 1, height, velocity: 3 })).toBe(false);
  });

  it("never dismisses an upward or empty drag", () => {
    expect(shouldDismissSheetDrag({ offset: 0, height, velocity: 5 })).toBe(false);
    expect(shouldDismissSheetDrag({ offset: -30, height, velocity: 5 })).toBe(false);
    expect(shouldDismissSheetDrag({ offset: 100, height: 0, velocity: 5 })).toBe(false);
  });
});

describe("releaseVelocity", () => {
  it("is the speed over the last 100 ms, so a long slow drag that ends in a flick counts as one", () => {
    const samples: Array<readonly [number, number]> = [
      [0, 0],
      [400, 40],
      [450, 60],
      [500, 120],
    ];
    expect(releaseVelocity(samples)).toBeCloseTo(0.8, 5);
  });

  it("is zero for a single sample or a stopped finger", () => {
    expect(releaseVelocity([])).toBe(0);
    expect(releaseVelocity([[10, 5]])).toBe(0);
    expect(
      releaseVelocity([
        [0, 0],
        [300, 200],
        [400, 200],
      ]),
    ).toBe(0);
  });
});

describe("sheetDragMayStart", () => {
  it("always starts from the drag zone, even over a button inside it", () => {
    const t = buildTree();
    t.body.scrollTop = 50;
    expect(sheetDragMayStart(t.zone, t.sheet)).toBe(true);
    expect(sheetDragMayStart(t.close, t.sheet)).toBe(true);
  });

  it("starts from the body only while it is scrolled to the top", () => {
    const t = buildTree();
    expect(sheetDragMayStart(t.text, t.sheet)).toBe(true);
    t.body.scrollTop = 1;
    expect(sheetDragMayStart(t.text, t.sheet)).toBe(false);
  });

  it("does not start from a no-drag element or outside the sheet", () => {
    const t = buildTree();
    expect(sheetDragMayStart(t.lockInner, t.sheet)).toBe(false);
    expect(sheetDragMayStart(new FakeEl("elsewhere"), t.sheet)).toBe(false);
    expect(sheetDragMayStart(null, t.sheet)).toBe(false);
  });
});

describe("useSheetDragDismiss", () => {
  const HEIGHT = 400;
  let tree: ReturnType<typeof buildTree>;
  let renderer: ReactTestRenderer;
  let onDismiss: Mock<() => void>;
  let reduced = false;

  function Probe() {
    const ref = useSheetDragDismiss(() => onDismiss());
    return createElement("div", { ref });
  }

  const sheet = () => tree.sheet;
  const $ = (id: "zone" | "text" | "tap" | "body") => tree[id];

  function fire(target: FakeEl, type: string, touches: Array<{ x: number; y: number }>, t: number) {
    const event = {
      target,
      touches: touches.map((point) => ({ clientX: point.x, clientY: point.y })),
      timeStamp: t,
      cancelable: true,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    act(() => {
      target.dispatch(type, event);
    });
    return event;
  }

  /** Drags `target` down by `dy`, finishing after `ms`, and lifts the finger. */
  function drag(target: FakeEl, dy: number, ms: number, steps = 6) {
    fire(target, "touchstart", [{ x: 100, y: 300 }], 0);
    for (let step = 1; step <= steps; step += 1) {
      fire(target, "touchmove", [{ x: 100, y: 300 + (dy * step) / steps }], (ms * step) / steps);
    }
    fire(target, "touchend", [], ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    reduced = false;
    vi.stubGlobal("window", {
      matchMedia: (query: string) => ({ matches: reduced && query.includes("reduce") }),
    });
    onDismiss = vi.fn<() => void>();
    tree = buildTree();
    tree.sheet.rectHeight = HEIGHT;
    act(() => {
      renderer = create(createElement(Probe), { createNodeMock: () => tree.sheet });
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("follows the finger through a transform and dismisses past a quarter of the height", () => {
    fire($("zone"), "touchstart", [{ x: 100, y: 300 }], 0);
    fire($("zone"), "touchmove", [{ x: 100, y: 310 }], 100);
    fire($("zone"), "touchmove", [{ x: 100, y: 360 }], 500);
    expect(sheet().style.transform).toBe("translateY(50px)");
    fire($("zone"), "touchmove", [{ x: 100, y: 440 }], 1000);
    expect(sheet().style.transform).toBe("translateY(130px)");
    fire($("zone"), "touchend", [], 1100);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet().style.transform).toBe(`translateY(${HEIGHT}px)`);
  });

  it("dismisses a fast flick shorter than a quarter of the height", () => {
    drag($("zone"), 60, 80);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("springs a short slow drag back and does not dismiss", () => {
    drag($("zone"), 60, 900);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet().style.transform).toBe("translateY(0px)");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(sheet().style.transform).toBe("");
    expect(sheet().style.transition).toBe("");
  });

  it("snaps instead of animating with reduced motion", () => {
    reduced = true;
    drag($("zone"), 60, 900);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet().style.transform).toBe("");
    drag($("zone"), 300, 900);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet().style.transition).toBe("none");
  });

  it("keeps the page from scrolling once a drag is under way", () => {
    fire($("zone"), "touchstart", [{ x: 100, y: 300 }], 0);
    const first = fire($("zone"), "touchmove", [{ x: 100, y: 304 }], 20);
    expect(first.defaultPrevented).toBe(false);
    const second = fire($("zone"), "touchmove", [{ x: 100, y: 330 }], 40);
    expect(second.defaultPrevented).toBe(true);
  });

  it("drags from the body when it is at the top, and not when it is scrolled", () => {
    drag($("text"), 300, 600);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    onDismiss.mockClear();
    sheet().style.transform = "";
    sheet().style.transition = "";
    $("body").scrollTop = 40;
    const start = fire($("text"), "touchstart", [{ x: 100, y: 300 }], 0);
    const move = fire($("text"), "touchmove", [{ x: 100, y: 500 }], 100);
    fire($("text"), "touchend", [], 120);
    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet().style.transform).toBe("");
  });

  it("leaves an upward scroll, a sideways swipe and a tap alone", () => {
    drag($("text"), -200, 300);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet().style.transform).toBe("");

    fire($("text"), "touchstart", [{ x: 100, y: 300 }], 0);
    const sideways = fire($("text"), "touchmove", [{ x: 220, y: 320 }], 50);
    fire($("text"), "touchend", [], 60);
    expect(sideways.defaultPrevented).toBe(false);
    expect(sheet().style.transform).toBe("");

    fire($("tap"), "touchstart", [{ x: 100, y: 300 }], 0);
    fire($("tap"), "touchmove", [{ x: 101, y: 302 }], 20);
    fire($("tap"), "touchend", [], 40);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet().style.transform).toBe("");
  });

  it("gives the sheet back when a second finger joins or the gesture is cancelled", () => {
    fire($("zone"), "touchstart", [{ x: 100, y: 300 }], 0);
    fire($("zone"), "touchmove", [{ x: 100, y: 340 }], 50);
    fire(
      $("zone"),
      "touchmove",
      [
        { x: 100, y: 360 },
        { x: 200, y: 360 },
      ],
      80,
    );
    fire($("zone"), "touchend", [], 100);
    expect(onDismiss).not.toHaveBeenCalled();

    fire($("zone"), "touchstart", [{ x: 100, y: 300 }], 200);
    fire($("zone"), "touchmove", [{ x: 100, y: 380 }], 260);
    fire($("zone"), "touchcancel", [], 280);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet().style.transform).toBe("");
  });

  it("springs back a sheet whose owner refused to close", () => {
    drag($("zone"), 300, 400);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(sheet().style.transform).toBe(`translateY(${HEIGHT}px)`);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(sheet().style.transform).toBe("translateY(0px)");
  });
});
