import { describe, expect, it, vi } from "vite-plus/test";

import { createWheelBatcher, type WheelStep } from "./wheelBatcher";

describe("createWheelBatcher", () => {
  it("coalesces multiple touch moves in one frame into a single Wheel step", () => {
    const emitted: WheelStep[] = [];
    let scheduled: (() => void) | null = null;
    const batcher = createWheelBatcher(
      (step) => emitted.push(step),
      (run) => {
        scheduled = run;
        return () => {
          scheduled = null;
        };
      },
    );

    batcher.push({ x: 100, y: 200, deltaX: 2, deltaY: 10 });
    batcher.push({ x: 104, y: 215, deltaX: -1, deltaY: 18 });
    batcher.push({ x: 108, y: 230, deltaX: 3, deltaY: 12 });

    expect(emitted).toEqual([]);
    expect(scheduled).not.toBeNull();
    scheduled!();

    expect(emitted).toEqual([{ x: 108, y: 230, deltaX: 4, deltaY: 40 }]);
  });

  it("flushes pending deltas immediately before another input and cancels its timer", () => {
    const emitted: WheelStep[] = [];
    const cancelSpy = vi.fn();
    const batcher = createWheelBatcher(
      (step) => emitted.push(step),
      () => cancelSpy,
    );

    batcher.push({ x: 50, y: 60, deltaX: 0, deltaY: 25 });
    batcher.flush();
    batcher.flush();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([{ x: 50, y: 60, deltaX: 0, deltaY: 25 }]);
  });

  it("drops pending deltas on cancel without emitting", () => {
    const emitted: WheelStep[] = [];
    const cancelSpy = vi.fn();
    const batcher = createWheelBatcher(
      (step) => emitted.push(step),
      () => cancelSpy,
    );

    batcher.push({ x: 10, y: 20, deltaX: 5, deltaY: 15 });
    batcher.cancel();
    batcher.flush();

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([]);
  });

  it("starts a fresh batch on the next frame after emitting", () => {
    const emitted: WheelStep[] = [];
    let scheduled: (() => void) | null = null;
    const batcher = createWheelBatcher(
      (step) => emitted.push(step),
      (run) => {
        scheduled = run;
        return () => {
          scheduled = null;
        };
      },
    );

    batcher.push({ x: 1, y: 2, deltaX: 1, deltaY: 2 });
    scheduled!();
    batcher.push({ x: 3, y: 4, deltaX: 5, deltaY: 6 });
    scheduled!();

    expect(emitted).toEqual([
      { x: 1, y: 2, deltaX: 1, deltaY: 2 },
      { x: 3, y: 4, deltaX: 5, deltaY: 6 },
    ]);
  });
});
