import { describe, expect, it } from "vite-plus/test";

import { type GestureAction, TouchGestureRecognizer } from "./desktopGestures";

function harness() {
  let clock = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 1;
  const actions: GestureAction[] = [];
  const recognizer = new TouchGestureRecognizer({
    emit: (action) => actions.push(action),
    now: () => clock,
    setTimer: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: clock + ms, run });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, timer] of timers) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  const types = () => actions.map((action) => action.type);
  return { recognizer, actions, advance, types };
}

describe("TouchGestureRecognizer", () => {
  it("a tap is a left click where the finger lifted, even after a little jitter", () => {
    const { recognizer, actions, advance } = harness();
    recognizer.down({ id: 1, x: 100, y: 100 });
    advance(80);
    recognizer.move({ id: 1, x: 104, y: 103 });
    recognizer.up({ id: 1, x: 104, y: 103 });
    expect(actions).toEqual([{ type: "click", x: 104, y: 103, button: "left" }]);
  });

  it("a double tap snaps the second click onto the first, so the PC sees a double click", () => {
    const { recognizer, actions, advance } = harness();
    recognizer.down({ id: 1, x: 100, y: 100 });
    recognizer.up({ id: 1, x: 100, y: 100 });
    advance(180);
    recognizer.down({ id: 2, x: 112, y: 108 });
    recognizer.up({ id: 2, x: 112, y: 108 });
    expect(actions).toEqual([
      { type: "click", x: 100, y: 100, button: "left" },
      { type: "click", x: 100, y: 100, button: "left", snapped: true },
    ]);
    // A third tap starts over: a single click, not a triple.
    advance(100);
    recognizer.down({ id: 3, x: 100, y: 100 });
    recognizer.up({ id: 3, x: 100, y: 100 });
    expect(actions.at(-1)).toEqual({ type: "click", x: 100, y: 100, button: "left" });
  });

  it("taps too far apart in time or space are two single clicks", () => {
    const { recognizer, actions, advance } = harness();
    recognizer.down({ id: 1, x: 100, y: 100 });
    recognizer.up({ id: 1, x: 100, y: 100 });
    advance(500);
    recognizer.down({ id: 2, x: 100, y: 100 });
    recognizer.up({ id: 2, x: 100, y: 100 });
    advance(100);
    recognizer.down({ id: 3, x: 200, y: 100 });
    recognizer.up({ id: 3, x: 200, y: 100 });
    expect(actions.filter((action) => action.type === "click" && action.snapped)).toEqual([]);
    expect(actions).toHaveLength(3);
  });

  it("a long press right-clicks while the finger is still down, and lifting adds nothing", () => {
    const { recognizer, actions, advance } = harness();
    recognizer.down({ id: 1, x: 50, y: 60 });
    advance(549);
    expect(actions).toEqual([]);
    advance(1);
    expect(actions).toEqual([
      { type: "press", x: 50, y: 60 },
      { type: "click", x: 50, y: 60, button: "right" },
    ]);
    recognizer.move({ id: 1, x: 90, y: 60 });
    recognizer.up({ id: 1, x: 90, y: 60 });
    expect(actions).toHaveLength(2);
  });

  it("holding briefly then moving drags from the start point, and ends where the finger lifts", () => {
    const { recognizer, types, actions, advance } = harness();
    recognizer.down({ id: 1, x: 10, y: 10 });
    advance(300);
    recognizer.move({ id: 1, x: 40, y: 10 });
    recognizer.move({ id: 1, x: 80, y: 20 });
    recognizer.up({ id: 1, x: 80, y: 20 });
    expect(types()).toEqual(["dragStart", "dragMove", "dragMove", "dragEnd"]);
    expect(actions[0]).toEqual({ type: "dragStart", x: 10, y: 10 });
    expect(actions.at(-1)).toEqual({ type: "dragEnd", x: 80, y: 20 });
    // The long-press timer was cancelled by the move: no right click later.
    advance(1_000);
    expect(types()).not.toContain("click");
  });

  it("moving straight away pans the view instead of touching the PC", () => {
    const { recognizer, actions } = harness();
    recognizer.down({ id: 1, x: 100, y: 100 });
    recognizer.move({ id: 1, x: 120, y: 100 });
    recognizer.move({ id: 1, x: 130, y: 90 });
    recognizer.up({ id: 1, x: 130, y: 90 });
    expect(actions).toEqual([
      { type: "pan", dx: 20, dy: 0 },
      { type: "pan", dx: 10, dy: -10 },
    ]);
  });

  it("two fingers moving together scroll the PC; fingers moving up scroll down", () => {
    const { recognizer, actions, types } = harness();
    recognizer.down({ id: 1, x: 100, y: 300 });
    recognizer.down({ id: 2, x: 200, y: 300 });
    recognizer.move({ id: 1, x: 100, y: 280 });
    recognizer.move({ id: 2, x: 200, y: 280 });
    recognizer.move({ id: 1, x: 100, y: 260 });
    recognizer.up({ id: 1, x: 100, y: 260 });
    recognizer.move({ id: 2, x: 200, y: 200 });
    recognizer.up({ id: 2, x: 200, y: 200 });
    expect(types().every((type) => type === "scroll")).toBe(true);
    const total = actions.reduce(
      (sum, action) => sum + (action.type === "scroll" ? action.dy : 0),
      0,
    );
    // The slop travelled before it became a scroll counts; nothing after a finger lifted.
    expect(total).toBe(30);
    expect(actions[0]).toMatchObject({ x: 150, y: 280, dx: 0, dy: 20 });
  });

  it("two fingers spreading zoom the view around their centre, never the PC", () => {
    const { recognizer, actions } = harness();
    recognizer.down({ id: 1, x: 100, y: 100 });
    recognizer.down({ id: 2, x: 200, y: 100 });
    recognizer.move({ id: 2, x: 250, y: 100 });
    const zoom = actions.find((action) => action.type === "zoom");
    expect(zoom).toMatchObject({ factor: 1.5, cx: 175, cy: 100 });
    expect(actions.some((action) => action.type === "scroll" || action.type === "click")).toBe(
      false,
    );
  });

  it("a second finger during a drag ends the drag, so the button is never left down", () => {
    const { recognizer, types, advance } = harness();
    recognizer.down({ id: 1, x: 10, y: 10 });
    advance(300);
    recognizer.move({ id: 1, x: 40, y: 10 });
    recognizer.down({ id: 2, x: 90, y: 90 });
    recognizer.move({ id: 2, x: 120, y: 120 });
    recognizer.up({ id: 1, x: 40, y: 10 });
    recognizer.up({ id: 2, x: 120, y: 120 });
    expect(types()).toEqual(["dragStart", "dragMove", "dragEnd"]);
  });

  it("a cancelled or reset drag still lets go of the button", () => {
    const { recognizer, types, advance } = harness();
    recognizer.down({ id: 1, x: 10, y: 10 });
    advance(300);
    recognizer.move({ id: 1, x: 40, y: 10 });
    recognizer.cancel(1);
    expect(types()).toEqual(["dragStart", "dragMove", "dragEnd"]);

    const second = harness();
    second.recognizer.down({ id: 1, x: 10, y: 10 });
    second.advance(300);
    second.recognizer.move({ id: 1, x: 40, y: 10 });
    second.recognizer.reset();
    expect(second.types()).toEqual(["dragStart", "dragMove", "dragEnd"]);
  });
});
