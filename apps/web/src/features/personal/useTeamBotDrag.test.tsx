import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { TEAM_DRAG_LONG_PRESS_MS, useTeamBotDrag } from "./useTeamBotDrag";

// A window that is only an event target with a manual frame clock: the hook
// listens on it, and every frame is stepped by hand.
let frames: Array<() => void> = [];
let win: EventTarget;

function runFrame() {
  const due = frames;
  frames = [];
  for (const callback of due) callback();
}

function pointer(type: string, x: number, y: number) {
  return Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1,
    clientX: x,
    clientY: y,
  });
}

const options = () => ({
  zoneAt: vi.fn((x: number) => (x < 100 ? null : x < 200 ? "team:a" : "team:b")),
  onLift: vi.fn(),
  onHover: vi.fn(),
  onDrop: vi.fn(),
  onCancel: vi.fn(),
});

function setup(opts = options()) {
  const seen = { renders: 0, last: null as ReturnType<typeof useTeamBotDrag> | null };
  function Probe() {
    const value = useTeamBotDrag(opts);
    seen.renders += 1;
    seen.last = value;
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Probe />);
  });
  const token = { style: { transform: "" } } as unknown as HTMLElement;
  const element = {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  } as unknown as HTMLElement;
  const start = () =>
    act(() => {
      seen.last!.handlersFor("bot-1").onPointerDown({
        pointerType: "touch",
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        currentTarget: element,
      } as never);
      vi.advanceTimersByTime(TEAM_DRAG_LONG_PRESS_MS + 1);
    });
  return { opts, seen, token, start, renderer };
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  win = Object.assign(new EventTarget(), {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: (id: number) => {
      frames[id - 1] = () => undefined;
    },
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { body: { style: { setProperty: vi.fn(), removeProperty: vi.fn() } } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useTeamBotDrag", () => {
  it("does not render on pointer moves, only when the card under the finger changes", () => {
    const { opts, seen, token, start } = setup();
    start();
    act(() => seen.last!.tokenRef(token));
    expect(opts.onLift).toHaveBeenCalledWith("bot-1");
    const afterLift = seen.renders;

    // 40 moves inside one card: frames run, the token moves, React is not asked.
    act(() => {
      for (let i = 0; i < 40; i += 1) {
        win.dispatchEvent(pointer("pointermove", 120 + i, 50));
        runFrame();
      }
    });
    expect(seen.renders - afterLift).toBe(1); // entering team:a
    expect(opts.onHover).toHaveBeenCalledTimes(1);
    expect(seen.last!.drag?.zoneId).toBe("team:a");

    const beforeSecondCard = seen.renders;
    act(() => {
      win.dispatchEvent(pointer("pointermove", 230, 50));
      runFrame();
    });
    expect(seen.renders - beforeSecondCard).toBe(1); // entering team:b
    expect(opts.onHover).toHaveBeenLastCalledWith("bot-1", "team:b");
  });

  it("moves the token with transform only, at most once a frame", () => {
    const { opts, seen, token, start } = setup();
    start();
    act(() => seen.last!.tokenRef(token));
    // Under the finger the moment it mounts.
    expect(token.style.transform).toContain("translate3d(-30px, -42px, 0)");
    act(() => {
      for (let i = 0; i < 5; i += 1) win.dispatchEvent(pointer("pointermove", 150 + i, 300));
    });
    expect(frames.length).toBe(1);
    act(() => runFrame());
    expect(token.style.transform).toContain("translate3d(114px, 248px, 0)");
    expect(opts.zoneAt).toHaveBeenCalledTimes(1);
  });

  it("blocks touch scrolling from the moment of the lift", () => {
    const { start } = setup();
    start();
    const move = new Event("touchmove", { cancelable: true });
    win.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
  });

  it("drops over the card under the finger and lets go of everything", () => {
    const { opts, seen, token, start } = setup();
    start();
    act(() => seen.last!.tokenRef(token));
    act(() => {
      win.dispatchEvent(pointer("pointermove", 150, 60));
      runFrame();
      win.dispatchEvent(pointer("pointerup", 150, 60));
    });
    expect(opts.onDrop).toHaveBeenCalledWith("bot-1", "team:a");
    expect(seen.last!.drag).toBeNull();
    const move = new Event("touchmove", { cancelable: true });
    win.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(false);
    // A move after the drop schedules nothing.
    win.dispatchEvent(pointer("pointermove", 10, 10));
    expect(frames.length).toBe(0);
  });

  it("a press that moves before the timer is a scroll, not a lift", () => {
    const { opts, seen } = setup();
    act(() => {
      seen.last!.handlersFor("bot-1").onPointerDown({
        pointerType: "touch",
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        currentTarget: {} as HTMLElement,
      } as never);
      seen.last!.handlersFor("bot-1").onPointerMove({
        pointerId: 1,
        clientX: 10,
        clientY: 40,
      } as never);
      vi.advanceTimersByTime(TEAM_DRAG_LONG_PRESS_MS + 50);
    });
    expect(opts.onLift).not.toHaveBeenCalled();
    expect(seen.last!.drag).toBeNull();
  });
});
