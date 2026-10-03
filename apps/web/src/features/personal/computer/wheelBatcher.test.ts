import { describe, expect, it } from "vite-plus/test";

import { createWheelBatcher, type WheelStep } from "./wheelBatcher";

/** A frame clock the test advances by hand. */
const setup = () => {
  const sent: WheelStep[] = [];
  let frame: (() => void) | null = null;
  const batcher = createWheelBatcher(
    (step) => sent.push(step),
    (run) => {
      frame = run;
      return () => {
        frame = null;
      };
    },
  );
  return { batcher, sent, nextFrame: () => frame?.() };
};

describe("wheel batcher", () => {
  it("sends one summed step per frame, at the latest point", () => {
    const { batcher, sent, nextFrame } = setup();
    batcher.push({ x: 1, y: 1, deltaX: 0, deltaY: 4 });
    batcher.push({ x: 2, y: 3, deltaX: 1, deltaY: 6 });
    batcher.push({ x: 5, y: 9, deltaX: -1, deltaY: 2 });
    expect(sent).toEqual([]);
    nextFrame();
    expect(sent).toEqual([{ x: 5, y: 9, deltaX: 0, deltaY: 12 }]);
    // The next frame starts afresh, and an idle frame sends nothing.
    nextFrame();
    batcher.push({ x: 7, y: 7, deltaX: 0, deltaY: 1 });
    nextFrame();
    expect(sent.at(-1)).toEqual({ x: 7, y: 7, deltaX: 0, deltaY: 1 });
    expect(sent).toHaveLength(2);
  });

  it("sends what is pending at once on flush, so a later input cannot overtake it", () => {
    const { batcher, sent, nextFrame } = setup();
    batcher.push({ x: 1, y: 1, deltaX: 0, deltaY: 4 });
    batcher.flush();
    expect(sent).toEqual([{ x: 1, y: 1, deltaX: 0, deltaY: 4 }]);
    nextFrame();
    expect(sent).toHaveLength(1);
    batcher.flush();
    expect(sent).toHaveLength(1);
  });

  it("drops what is pending on cancel", () => {
    const { batcher, sent, nextFrame } = setup();
    batcher.push({ x: 1, y: 1, deltaX: 0, deltaY: 4 });
    batcher.cancel();
    nextFrame();
    expect(sent).toEqual([]);
  });
});
