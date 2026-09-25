import { describe, expect, it } from "@effect/vitest";

import { DesktopCoordinateError } from "./desktopGeometry.ts";
import { DesktopKeyError } from "./desktopKeys.ts";
import {
  InputRateLimiter,
  isDroppableInput,
  planRemoteInput,
  type RemoteDesktopInput,
} from "./desktopRemote.ts";

/** The dev box: one 3072x1920 monitor at 200%. */
const PRIMARY = { x: 0, y: 0, width: 3072, height: 1920 };
/** The app draws it 1170x731 on a phone. */
const frame = { frameWidth: 1170, frameHeight: 731 };

describe("planRemoteInput", () => {
  it("maps a tap on the phone's frame onto the physical pixel under it", () => {
    const command = planRemoteInput(
      { _tag: "Pointer", action: "click", x: 585, y: 365, ...frame },
      PRIMARY,
    );
    expect(command.cmd).toBe("click");
    // Centre of frame pixel (585, 365): 585.5 * 3072/1170 = 1537.3, 365.5 * 1920/731 = 960.0
    expect(command.params).toMatchObject({ x: 1537, y: 960, button: "left", count: 1 });
    expect(command.params.remote).toBe(true);
  });

  it("maps a zoomed-in tap given in monitor pixels onto exactly that pixel", () => {
    // A region-aware app sends the monitor pixel under the finger with the
    // monitor's own size as the frame, whatever region it has on screen.
    const screen = { frameWidth: 3072, frameHeight: 1920 };
    for (const [x, y] of [
      [1100, 700],
      [0, 0],
      [3071, 1919],
    ] as const) {
      const command = planRemoteInput(
        { _tag: "Pointer", action: "click", x, y, ...screen },
        PRIMARY,
      );
      expect(command.params).toMatchObject({ x, y });
    }
    const offset = { x: 1920, y: 0, width: 3072, height: 1920 };
    expect(
      planRemoteInput(
        { _tag: "Scroll", x: 1100, y: 700, ...screen, deltaX: 0, deltaY: 120 },
        offset,
      ).params,
    ).toMatchObject({ x: 3020, y: 700 });
  });

  it("maps the frame's corners inside the monitor, including a monitor at a negative origin", () => {
    const left = { x: -1920, y: -200, width: 1920, height: 1080 };
    const topLeft = planRemoteInput(
      { _tag: "Pointer", action: "move", x: 0, y: 0, frameWidth: 960, frameHeight: 540 },
      left,
    );
    expect(topLeft.params).toMatchObject({ x: -1919, y: -199 });
    const bottomRight = planRemoteInput(
      { _tag: "Pointer", action: "move", x: 959.9, y: 539.9, frameWidth: 960, frameHeight: 540 },
      left,
    );
    expect(bottomRight.params).toMatchObject({ x: -1, y: 879 });
  });

  it("refuses points outside the frame rather than clamping them", () => {
    expect(() =>
      planRemoteInput({ _tag: "Pointer", action: "click", x: 1170, y: 10, ...frame }, PRIMARY),
    ).toThrow(DesktopCoordinateError);
    expect(() =>
      planRemoteInput({ _tag: "Scroll", x: 10, y: 731, ...frame, deltaX: 0, deltaY: 120 }, PRIMARY),
    ).toThrow(DesktopCoordinateError);
  });

  it("turns drags into button down and up at their points, and long presses into right clicks", () => {
    const down = planRemoteInput(
      { _tag: "Pointer", action: "down", x: 100, y: 100, ...frame },
      PRIMARY,
    );
    expect(down).toMatchObject({ cmd: "button", params: { button: "left", down: true } });
    const up = planRemoteInput(
      { _tag: "Pointer", action: "up", x: 200, y: 100, ...frame },
      PRIMARY,
    );
    expect(up).toMatchObject({ cmd: "button", params: { button: "left", down: false } });
    const right = planRemoteInput(
      { _tag: "Pointer", action: "click", x: 100, y: 100, ...frame, button: "right" },
      PRIMARY,
    );
    expect(right.params).toMatchObject({ button: "right", count: 1 });
  });

  it("holds the sticky modifiers for a click, each once, as virtual keys", () => {
    const command = planRemoteInput(
      {
        _tag: "Pointer",
        action: "click",
        x: 1,
        y: 1,
        ...frame,
        count: 2,
        modifiers: ["ctrl", "shift", "ctrl"],
      },
      PRIMARY,
    );
    expect(command.params).toMatchObject({ count: 2, modifiers: [0x11, 0x10] });
  });

  it("passes wheel deltas through in WHEEL_DELTA units, rounded", () => {
    const command = planRemoteInput(
      { _tag: "Scroll", x: 5, y: 5, ...frame, deltaX: -60.4, deltaY: 240.6 },
      PRIMARY,
    );
    expect(command).toMatchObject({ cmd: "wheel", params: { dx: -60, dy: 241, remote: true } });
  });

  it("presses one allowlisted key combination at a time", () => {
    expect(planRemoteInput({ _tag: "Keys", keys: "ctrl+c" }, PRIMARY)).toMatchObject({
      cmd: "keys",
      params: { combos: [[0x11, 0x43]], repeat: 1, remote: true },
    });
    expect(planRemoteInput({ _tag: "Keys", keys: "alt+tab" }, PRIMARY).params.combos).toEqual([
      [0x12, 0x09],
    ]);
    expect(planRemoteInput({ _tag: "Keys", keys: "win" }, PRIMARY).params.combos).toEqual([[0x5b]]);
    expect(() => planRemoteInput({ _tag: "Keys", keys: "ctrl+a delete" }, PRIMARY)).toThrow(
      DesktopKeyError,
    );
    expect(() => planRemoteInput({ _tag: "Keys", keys: "hyper+x" }, PRIMARY)).toThrow(
      DesktopKeyError,
    );
  });

  it("types text as the owner, with a timeout that grows with its length", () => {
    const command = planRemoteInput({ _tag: "Text", text: "hello" }, PRIMARY);
    expect(command).toMatchObject({ cmd: "type", params: { text: "hello", remote: true } });
    expect(command.timeoutMs).toBe(10_100);
  });

  it("only ever drops plain moves", () => {
    const inputs: RemoteDesktopInput[] = [
      { _tag: "Pointer", action: "move", x: 1, y: 1, ...frame },
      { _tag: "Pointer", action: "down", x: 1, y: 1, ...frame },
      { _tag: "Keys", keys: "enter" },
      { _tag: "Text", text: "a" },
    ];
    expect(inputs.map(isDroppableInput)).toEqual([true, false, false, false]);
  });
});

describe("InputRateLimiter", () => {
  it("allows a burst, then refills at the steady rate", () => {
    let now = 0;
    const limiter = new InputRateLimiter({ capacity: 3, perSecond: 10, now: () => now });
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now = 100; // one token back
    expect([limiter.take(), limiter.take()]).toEqual([true, false]);
    now = 10_000; // never more than the burst
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});
