import { describe, expect, it } from "vite-plus/test";

import { createPhoneMeter } from "./streamPhoneMeter";

const setup = () => {
  const clock = { now: 1_000 };
  return { clock, meter: createPhoneMeter(() => clock.now) };
};

describe("phone stream meter", () => {
  it("counts frames, the longest gap, decode and paint times", () => {
    const { clock, meter } = setup();
    const receive = (decodeMs: number, paintMs: number) => {
      const receivedAt = meter.frameReceived();
      const decodeStartedAt = clock.now;
      clock.now += decodeMs;
      const decodedAt = clock.now;
      clock.now += paintMs;
      meter.framePainted({ receivedAt, decodeStartedAt, decodedAt, paintedAt: clock.now });
    };
    receive(10, 2);
    clock.now += 80;
    receive(30, 4);
    meter.frameReplaced();
    clock.now += 100;

    const stats = meter.snapshot()!;
    expect(stats).toMatchObject({
      _tag: "StreamStats",
      frames: 2,
      replaced: 1,
      taps: 0,
      wheels: 0,
    });
    expect(stats.maxGapMs).toBe(92);
    expect(stats.decode).toEqual({ p50: 30, p95: 30 });
    expect(stats.paint).toEqual({ p50: 4, p95: 4 });
    expect(stats.receiveToPaint).toEqual({ p50: 34, p95: 34 });
  });

  it("times a tap or a scroll to the first frame that can show it", () => {
    const { clock, meter } = setup();
    // A frame received before the tap does not answer it, even if painted after.
    const early = meter.frameReceived();
    clock.now += 5;
    meter.inputSent("tap");
    meter.inputSent("wheel");
    clock.now += 20;
    meter.framePainted({
      receivedAt: early,
      decodeStartedAt: early,
      decodedAt: clock.now,
      paintedAt: clock.now,
    });
    expect(meter.snapshot()!.tapToPaint).toBeUndefined();

    meter.inputSent("tap");
    clock.now += 40;
    const late = meter.frameReceived();
    clock.now += 15;
    meter.framePainted({
      receivedAt: late,
      decodeStartedAt: late,
      decodedAt: clock.now,
      paintedAt: clock.now,
    });
    const stats = meter.snapshot()!;
    expect(stats.tapToPaint).toEqual({ p50: 75, p95: 75 });
    expect(stats.wheelToPaint).toEqual({ p50: 75, p95: 75 });
  });

  it("starts a fresh window after each snapshot and is silent when nothing happened", () => {
    const { clock, meter } = setup();
    meter.frameReceived();
    meter.inputSent("wheel");
    expect(meter.snapshot()).not.toBeNull();
    clock.now += 5_000;
    expect(meter.snapshot()).toBeNull();
  });
});
