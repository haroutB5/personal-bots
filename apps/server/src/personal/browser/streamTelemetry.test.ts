import { describe, expect, it } from "@effect/vitest";

import { ViewerFlow } from "./viewerFlow.ts";
import { ViewerTelemetry } from "./streamTelemetry.ts";

const frame = (size = 1_000) => new Uint8Array(size);

/** A viewer's flow and telemetry on one clock the test moves by hand. */
const fixture = () => {
  const clock = { now: 10_000 };
  const flow = new ViewerFlow({ now: () => clock.now });
  const telemetry = new ViewerTelemetry({
    viewerId: 3,
    canOperate: true,
    now: () => clock.now,
  });
  flow.setObserver(telemetry);
  return { clock, flow, telemetry };
};

/** Every leaf of a log line must be a number, a boolean or null: nothing textual. */
const leaves = (value: unknown, path = ""): Array<[string, unknown]> =>
  value !== null && typeof value === "object"
    ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, `${path}.${key}`))
    : [[path, value]];

describe("stream telemetry", () => {
  it("counts frames, drops, bytes and how long a frame waited to be sent", () => {
    const { clock, flow, telemetry } = fixture();
    flow.setBacklogProbe(() => 0);
    telemetry.chromeFrame();
    flow.offerFrame(frame(2_000));
    expect(flow.poll()._tag).toBe("Send");
    // Three frames arrive inside one 50 ms slot: two are overwritten, one waits for the cap.
    clock.now += 10;
    for (let i = 0; i < 3; i += 1) {
      telemetry.chromeFrame();
      flow.offerFrame(frame(4_000));
    }
    expect(flow.poll()._tag).toBe("Wait");
    clock.now += 40;
    expect(flow.poll()._tag).toBe("Send");

    clock.now += 4_950;
    const line = telemetry.flush() as Record<string, any>;
    expect(line.viewer).toBe(3);
    expect(line.seconds).toBe(5);
    expect(line.chrome.fps).toBeCloseTo(0.8, 1);
    expect(line.frames.sentPerS).toBeCloseTo(0.4, 1);
    expect(line.frames.replaced).toBe(2);
    expect(line.frames.avgBytes).toBe(3_000);
    expect(line.frames.blocked).toEqual({ fps: 1, ack: 0, socket: 0 });
    // The second frame arrived at +10 ms and left at +50 ms.
    expect(line.frames.queuedMs.p95).toBe(40);
  });

  it("pairs each acknowledgement with the frame it answers and reports blocking reasons", () => {
    const { clock, flow, telemetry } = fixture();
    let backlog = 0;
    flow.setBacklogProbe(() => backlog);
    const send = () => {
      flow.offerFrame(frame());
      let steps = 0;
      while (flow.poll()._tag !== "Send" && steps++ < 400) clock.now += 5;
    };
    send();
    flow.acknowledge(); // enables the window
    clock.now += 60;
    send();
    clock.now += 60;
    send();
    // Two frames owed: the next waits for the phone.
    clock.now += 60;
    flow.offerFrame(frame());
    expect(flow.poll()).toMatchObject({ _tag: "Wait" });
    clock.now += 120;
    flow.acknowledge();
    expect(flow.poll()._tag).toBe("Send");
    // A busy socket holds the one after.
    flow.acknowledge();
    flow.acknowledge();
    clock.now += 60;
    backlog = 100_000;
    flow.offerFrame(frame());
    expect(flow.poll()).toMatchObject({ _tag: "Wait" });
    backlog = 0;
    clock.now += 10;
    flow.poll();

    const line = telemetry.flush() as Record<string, any>;
    expect(line.frames.blocked.ack).toBe(1);
    expect(line.frames.blocked.socket).toBe(1);
    expect(line.frames.ackRttMs.n).toBe(4);
    expect(line.frames.ackRttMs.p95).toBeGreaterThanOrEqual(120);
  });

  it("reports a stalled acknowledgement window", () => {
    const { clock, flow, telemetry } = fixture();
    flow.offerFrame(frame());
    flow.poll();
    flow.acknowledge();
    for (let i = 0; i < 2; i += 1) {
      clock.now += 60;
      flow.offerFrame(frame());
      flow.poll();
    }
    clock.now += 60;
    flow.offerFrame(frame());
    flow.poll();
    clock.now += 2_500;
    expect(flow.poll()._tag).toBe("Send");
    expect((telemetry.flush() as Record<string, any>).frames.ackStalls).toBe(1);
  });

  it("times inputs by kind and measures how long the next frame took to follow one", () => {
    const { clock, flow, telemetry } = fixture();
    telemetry.inputQueued(4);
    telemetry.inputQueued(9);
    telemetry.inputQueued(2);
    // A tap that waited 30 ms in line and took 20 ms to dispatch.
    const arrivedAt = clock.now - 50;
    telemetry.inputHandled({ kind: "tap", arrivedAt, waitMs: 30, handleMs: 20, failed: false });
    telemetry.cdp("click", 18);
    // A frame that was already waiting before the tap was dispatched does not count.
    flow.offerFrame(frame());
    clock.now -= 5;
    clock.now += 5;
    telemetry.inputHandled({
      kind: "wheel",
      arrivedAt: clock.now,
      waitMs: 0,
      handleMs: 8,
      failed: false,
    });
    clock.now += 20;
    flow.offerFrame(frame());
    clock.now += 30;
    expect(flow.poll()._tag).toBe("Send");

    const line = telemetry.flush() as Record<string, any>;
    expect(line.input.queueMax).toBe(9);
    expect(line.input.perS.tap).toBeGreaterThan(0);
    expect(line.input.perS.wheel).toBeGreaterThan(0);
    expect(line.input.waitMs.p95).toBe(30);
    expect(line.input.handleMs.tap.p50).toBe(20);
    expect(line.input.handleMs.wheel.p50).toBe(8);
    expect(line.input.cdpMs.click.p50).toBe(18);
    // The frame offered after both inputs was dispatched answers the tap (50 ms + 50 ms) and the wheel.
    expect(line.input.toFrameMs.p50).toBe(100);
    expect(line.input.tapToFrameMs.p50).toBe(100);
    expect(line.input.wheelToFrameMs.p50).toBe(50);
  });

  it("reports the spacing of Chrome's frames, of our writes, and how late a write was", () => {
    const { clock, flow, telemetry } = fixture();
    flow.setBacklogProbe(() => 0);
    // Chrome renders every 40 ms; the cap (30 per second) lets one write out about every 40 ms.
    for (let i = 0; i < 20; i += 1) {
      flow.offerFrame(frame());
      flow.poll();
      flow.acknowledge();
      clock.now += 40;
    }
    clock.now += 100;
    const line = telemetry.flush() as Record<string, any>;
    expect(line.frames.offerGapMs.p50).toBe(40);
    expect(line.frames.sendGapMs.p50).toBe(40);
    expect(line.frames.lateMs.p95).toBe(0);
  });

  // Scrolling comes in bursts, and a rate over a whole window then reads as a fraction of
  // what a burst gets (a 5 s line showed 9 frames a second for bursts that ran at the cap).
  it("reads rates over the time the page was moving as well as over the window", () => {
    const { clock, flow, telemetry } = fixture();
    // One second of about 29 frames a second, then four quiet seconds.
    for (let i = 0; i < 30; i += 1) {
      telemetry.chromeFrame();
      flow.offerFrame(frame());
      flow.poll();
      flow.acknowledge();
      clock.now += 34;
    }
    clock.now += 4_010;
    const line = telemetry.flush() as Record<string, any>;
    expect(line.frames.sentPerS).toBeCloseTo(6, 0);
    expect(line.activeSeconds).toBeGreaterThanOrEqual(1);
    expect(line.activeSeconds).toBeLessThanOrEqual(1.25);
    expect(line.frames.sentPerActiveS).toBeGreaterThanOrEqual(24);
    expect(line.frames.sentPerActiveS).toBeLessThanOrEqual(30);
    expect(line.chrome.fpsActive).toBeGreaterThanOrEqual(24);
  });

  it("counts wheels merged into the one before them", () => {
    const { clock, telemetry } = fixture();
    telemetry.wheelMerged();
    telemetry.wheelMerged();
    telemetry.inputHandled({
      kind: "wheel",
      arrivedAt: clock.now,
      waitMs: 0,
      handleMs: 1,
      failed: false,
    });
    clock.now += 5_000;
    expect((telemetry.flush() as Record<string, any>).input.wheelMerged).toBe(2);
  });

  it("does not count a failed input as answered by a frame", () => {
    const { clock, flow, telemetry } = fixture();
    telemetry.inputHandled({
      kind: "tap",
      arrivedAt: clock.now,
      waitMs: 0,
      handleMs: 1,
      failed: true,
    });
    clock.now += 5;
    flow.offerFrame(frame());
    flow.poll();
    const line = telemetry.flush() as Record<string, any>;
    expect(line.input.failed).toBe(1);
    expect(line.input.toFrameMs).toBeNull();
  });

  it("starts a fresh window after each line, skips a quiet one and keeps totals for the summary", () => {
    const { clock, flow, telemetry } = fixture();
    flow.offerFrame(frame());
    flow.poll();
    clock.now += 5_000;
    expect(telemetry.flush()).not.toBeNull();
    clock.now += 5_000;
    expect(telemetry.flush()).toBeNull();
    clock.now += 5_000;
    const summary = telemetry.summary() as Record<string, any>;
    expect(summary.seconds).toBe(15);
    expect(summary.frames.sentPerS).toBe(0.07);
  });

  it("includes what the phone reported, once", () => {
    const { clock, telemetry } = fixture();
    telemetry.phone({ frames: 40, tapToPaint: { p50: 120, p95: 200 } });
    clock.now += 5_000;
    expect((telemetry.flush() as Record<string, any>).phone.frames).toBe(40);
    clock.now += 5_000;
    expect(telemetry.flush()).toBeNull();
  });

  it("never puts text in a line: only numbers, booleans and nulls", () => {
    const { clock, flow, telemetry } = fixture();
    flow.offerFrame(frame());
    flow.poll();
    telemetry.inputHandled({
      kind: "key",
      arrivedAt: clock.now,
      waitMs: 1,
      handleMs: 2,
      failed: false,
    });
    telemetry.phone({ frames: 3 });
    clock.now += 5_000;
    const line = telemetry.flush({ control: true });
    for (const [path, value] of leaves(line)) {
      expect(["number", "boolean", "object"], path).toContain(typeof value);
    }
    expect(Object.keys(line as object).sort()).toEqual(
      [
        "activeSeconds",
        "chrome",
        "control",
        "frames",
        "input",
        "operate",
        "phone",
        "seconds",
        "viewer",
      ].sort(),
    );
  });
});
