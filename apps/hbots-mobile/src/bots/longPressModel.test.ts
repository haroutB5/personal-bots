import { describe, expect, it } from "vite-plus/test";

import {
  LONG_PRESS_IDLE,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  longPressStep,
  type LongPressState,
} from "./longPressModel";

const holding: LongPressState = { kind: "holding", x: 10, y: 10 };

describe("longPressStep", () => {
  it("holds at 500 ms and an 8 px slop", () => {
    expect(LONG_PRESS_MS).toBe(500);
    expect(LONG_PRESS_SLOP_PX).toBe(8);
  });

  it("starts holding where the finger went down", () => {
    expect(longPressStep(LONG_PRESS_IDLE, { kind: "down", x: 10, y: 10 })).toEqual({
      state: holding,
      fire: false,
    });
  });

  it("fires once when the hold time passes", () => {
    const fired = longPressStep(holding, { kind: "elapsed" });
    expect(fired).toEqual({ state: { kind: "fired" }, fire: true });
    expect(longPressStep(fired.state, { kind: "elapsed" }).fire).toBe(false);
  });

  it("tolerates a small wobble", () => {
    expect(longPressStep(holding, { kind: "move", x: 14, y: 13 })).toEqual({
      state: holding,
      fire: false,
    });
  });

  it("gives way at 8 px of drag", () => {
    expect(longPressStep(holding, { kind: "move", x: 18, y: 10 })).toEqual({
      state: LONG_PRESS_IDLE,
      fire: false,
    });
    expect(longPressStep(LONG_PRESS_IDLE, { kind: "elapsed" }).fire).toBe(false);
  });

  it("ends when the finger lifts", () => {
    expect(longPressStep(holding, { kind: "end" }).state).toEqual(LONG_PRESS_IDLE);
    expect(longPressStep({ kind: "fired" }, { kind: "end" }).state).toEqual(LONG_PRESS_IDLE);
  });
});
