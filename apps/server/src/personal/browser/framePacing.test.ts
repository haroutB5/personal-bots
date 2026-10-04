/**
 * The live view's frame pacing in virtual time (see framePacingSim.ts): how many of
 * the frames Chrome renders reach the phone, how long the gaps are, and whether the
 * page's last change always does. `held` is the 1.60.35 behaviour (the kill switch's
 * path): every frame's ack waited until the next write, which left Chrome, with two
 * frames out, dropping page changes it never rendered later.
 */
import { describe, expect, it } from "@effect/vitest";

import { simulateFramePath, type FrameSimOptions } from "./framePacingSim.ts";

const base: FrameSimOptions = {
  mode: "early",
  changeEveryMs: 25,
  contentMs: 5_000,
  durationMs: 7_000,
  maxFps: 30,
  frameBytes: 90_000,
  linkBytesPerSecond: 0,
  rttMs: 60,
};

describe("frame pacing", () => {
  it("sends what Chrome renders, up to the cap, when the link allows", () => {
    // A scroll step every 25 ms: Chrome could render 40 a second, the cap is 30.
    const result = simulateFramePath(base);
    expect(result.sentPerSecond).toBeGreaterThanOrEqual(0.9 * 30);
    expect(result.sentPerSecond).toBeLessThanOrEqual(30.5);
  });

  it("tracks Chrome's own rate when that is below the cap", () => {
    // A scroll step every 45 ms is about 22 frames a second, as on the phone's real page.
    const result = simulateFramePath({ ...base, changeEveryMs: 45 });
    expect(result.sentPerSecond).toBeGreaterThanOrEqual(0.9 * (1_000 / 45));
  });

  it("never sends faster than the cap", () => {
    for (const maxFps of [20, 30]) {
      const result = simulateFramePath({ ...base, changeEveryMs: 8, maxFps });
      expect(result.sentPerSecond).toBeLessThanOrEqual(maxFps + 0.6);
    }
  });

  it("keeps the gap between writes near the frame interval while the page changes", () => {
    const result = simulateFramePath(base);
    expect(result.maxSendGapMs).toBeLessThanOrEqual(2 * (1_000 / 30));
  });

  it("is paced by the phone's acknowledgements, not the cap, on a long round trip", () => {
    // Two frames per 130 ms round trip is about 15 a second, whatever the cap.
    const result = simulateFramePath({ ...base, rttMs: 130 });
    expect(result.sentPerSecond).toBeGreaterThanOrEqual(13);
    expect(result.sentPerSecond).toBeLessThanOrEqual(2 / 0.13 + 0.5);
    expect(result.maxUnacked).toBeLessThanOrEqual(2);
  });

  it("is paced by the link on a slow one, with the newest frame always the one sent", () => {
    // 90 kB frames at 600 kB/s: about 6.7 a second.
    const result = simulateFramePath({ ...base, linkBytesPerSecond: 600_000 });
    expect(result.sentPerSecond).toBeGreaterThanOrEqual(5.5);
    expect(result.sentPerSecond).toBeLessThanOrEqual(7);
    expect(result.maxUnacked).toBeLessThanOrEqual(2);
    // Nothing waits long: a frame is overwritten rather than queued.
    expect(result.maxQueuedMs).toBeLessThanOrEqual(150);
  });

  describe("the adaptive acknowledgement window", () => {
    it("lets a long round trip carry the cap's rate: three frames out instead of two", () => {
      const fixed = simulateFramePath({ ...base, rttMs: 130 });
      const adaptive = simulateFramePath({ ...base, rttMs: 130, adaptiveWindow: true });
      // Two frames per 130 ms is 15 a second; three lifts it towards 23.
      expect(adaptive.sentPerSecond).toBeGreaterThanOrEqual(fixed.sentPerSecond * 1.35);
      expect(adaptive.maxUnacked).toBeLessThanOrEqual(3);
    });

    it("reaches the cap on a 85 ms round trip, which two frames cannot", () => {
      const fixed = simulateFramePath({ ...base, rttMs: 85 });
      const adaptive = simulateFramePath({ ...base, rttMs: 85, adaptiveWindow: true });
      expect(fixed.sentPerSecond).toBeLessThan(25);
      expect(adaptive.sentPerSecond).toBeGreaterThanOrEqual(0.9 * 30);
    });

    it("stays at two frames on a slow link, where a third would only queue", () => {
      const result = simulateFramePath({
        ...base,
        rttMs: 40,
        linkBytesPerSecond: 300_000,
        adaptiveWindow: true,
      });
      expect(result.maxUnacked).toBeLessThanOrEqual(2);
    });
  });

  describe("the page's last change", () => {
    const cadences = [16, 25, 45, 56];
    const links = [0, 1_500_000, 600_000];

    it("always reaches the phone, promptly, and Chrome never drops a change", () => {
      for (const changeEveryMs of cadences) {
        for (const linkBytesPerSecond of links) {
          const result = simulateFramePath({ ...base, changeEveryMs, linkBytesPerSecond });
          const label = `change every ${changeEveryMs} ms, link ${linkBytesPerSecond}`;
          expect(result.droppedChanges, label).toBe(0);
          expect(result.finalStateSent, label).toBe(true);
          // Written within a frame interval or the time the link needs, never "next paint".
          expect(result.lastFrameDelayMs ?? Infinity, label).toBeLessThanOrEqual(
            linkBytesPerSecond === 600_000 ? 250 : 70,
          );
        }
      }
    });

    it("was lost before: holding acks made Chrome drop changes, the last one included", () => {
      let lost = 0;
      let dropped = 0;
      for (const changeEveryMs of cadences) {
        for (const linkBytesPerSecond of links) {
          const result = simulateFramePath({
            ...base,
            mode: "held",
            maxFps: 20,
            changeEveryMs,
            linkBytesPerSecond,
          });
          dropped += result.droppedChanges;
          if (!result.finalStateSent) lost += 1;
        }
      }
      expect(dropped).toBeGreaterThan(100);
      expect(lost).toBeGreaterThan(0);
    });
  });

  it("held acks made Chrome render fewer frames than the page changed, early acks do not", () => {
    const slow = { ...base, linkBytesPerSecond: 1_500_000, changeEveryMs: 25 };
    const held = simulateFramePath({ ...slow, mode: "held", maxFps: 20 });
    const early = simulateFramePath(slow);
    // Held: Chrome rendered fewer frames than the page changed, because it was kept waiting.
    expect(held.droppedChanges).toBeGreaterThan(0);
    expect(early.droppedChanges).toBe(0);
    expect(early.chromeFramesPerSecond).toBeGreaterThan(held.chromeFramesPerSecond);
    expect(early.sentPerSecond).toBeGreaterThanOrEqual(held.sentPerSecond);
  });
});
