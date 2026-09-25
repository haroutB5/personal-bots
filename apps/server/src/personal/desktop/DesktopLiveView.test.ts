// @effect-diagnostics globalTimers:off - the hub paces itself with plain timers; the tests wait on them.
// @effect-diagnostics globalDate:off - the wait helper polls a plain clock.
import {
  decodePersonalBrowserFrame,
  decodePersonalDesktopFrame,
  PERSONAL_DESKTOP_VIEW_MAX_EDGE,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { DesktopHelperError } from "./DesktopHelper.ts";
import {
  type DesktopCaptureDriver,
  DesktopLiveViewHub,
  type LiveViewSink,
  type LiveViewTiming,
  regionPixels,
} from "./DesktopLiveView.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");

type Screen = "changing" | "still" | "locked" | "broken" | "monitor";

/** The monitor the "monitor" screen pretends to be (this PC's). */
const MONITOR = { width: 3072, height: 1920 };

/** What the real helper does: the region (or all) scaled into the box, never up. */
function helperFrame(params: Readonly<Record<string, unknown>>, counter: number) {
  const region =
    params.regionWidth === undefined
      ? { x: 0, y: 0, width: MONITOR.width, height: MONITOR.height }
      : {
          x: Number(params.regionX),
          y: Number(params.regionY),
          width: Number(params.regionWidth),
          height: Number(params.regionHeight),
        };
  const scale = Math.min(
    1,
    Number(params.maxWidth) / region.width,
    Number(params.maxHeight) / region.height,
  );
  return {
    data: JPEG,
    width: Math.round(region.width * scale),
    height: Math.round(region.height * scale),
    hash: `h-${counter}`,
    captureMs: 1,
    screenWidth: MONITOR.width,
    screenHeight: MONITOR.height,
    regionX: region.x,
    regionY: region.y,
    regionWidth: region.width,
    regionHeight: region.height,
  };
}

class FakeCapture implements DesktopCaptureDriver {
  readonly requests: Array<Readonly<Record<string, unknown>>> = [];
  disposed = false;
  screen: Screen = "changing";
  private counter = 0;

  request(cmd: string, params: Readonly<Record<string, unknown>> = {}) {
    expect(cmd).toBe("frame");
    this.requests.push(params);
    switch (this.screen) {
      case "locked":
        return Promise.resolve({ locked: true });
      case "broken":
        return Promise.reject(
          new DesktopHelperError("capture_failed", "The screen could not be captured."),
        );
      case "monitor":
        this.counter += 1;
        return Promise.resolve(helperFrame(params, this.counter));
      case "still":
        return Promise.resolve(
          params.lastHash === "h-still"
            ? { unchanged: true, hash: "h-still", captureMs: 1 }
            : { data: JPEG, width: 640, height: 400, hash: "h-still", captureMs: 1 },
        );
      default:
        this.counter += 1;
        return Promise.resolve({
          data: JPEG,
          width: Number(params.maxWidth),
          height: Math.round(Number(params.maxWidth) * 0.625),
          hash: `h-${this.counter}`,
          captureMs: 1,
        });
    }
  }

  dispose() {
    this.disposed = true;
  }
}

class RecordingSink implements LiveViewSink {
  readonly frames: Uint8Array[] = [];
  readonly states: string[] = [];
  frame = (bytes: Uint8Array) => {
    this.frames.push(bytes);
  };
  state = (state: string, detail?: string) => {
    this.states.push(detail === undefined ? state : `${state}: ${detail}`);
  };
}

const FAST: Partial<LiveViewTiming> = {
  frameIntervalMs: 5,
  idleIntervalMs: 10,
  lockedIntervalMs: 10,
  errorIntervalMs: 10,
  ackTimeoutMs: 60,
  lingerMs: 40,
  maxCaptureDuty: 1,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(2);
  }
}

function setup(timing: Partial<LiveViewTiming> = FAST, screen: Screen = "changing") {
  const drivers: FakeCapture[] = [];
  const logs: string[] = [];
  const hub = new DesktopLiveViewHub({
    createDriver: () => {
      const driver = new FakeCapture();
      driver.screen = screen;
      drivers.push(driver);
      return driver;
    },
    timing,
    log: (line) => logs.push(line),
  });
  return { hub, drivers, logs };
}

describe("desktop live view", () => {
  it("costs nothing until someone watches, then streams frames sized for the viewer", async () => {
    const { hub, drivers } = setup();
    await sleep(20);
    expect(drivers).toHaveLength(0);
    expect(hub.captureRunning).toBe(false);

    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    viewer.setViewport(1170, 1170);
    await until(() => sink.frames.length === 1, "the first frame");
    expect(drivers).toHaveLength(1);
    expect(sink.states).toEqual(["live"]);
    const decoded = decodePersonalBrowserFrame(sink.frames[0]!);
    expect(decoded?.meta.width).toBeGreaterThan(0);
    expect(Array.from(decoded!.jpeg.subarray(0, 2))).toEqual([0xff, 0xd8]);
    viewer.detach();
    hub.dispose();
  });

  it("never has more than one frame in flight: the next capture waits for the ack", async () => {
    const { hub, drivers } = setup({ ...FAST, ackTimeoutMs: 5_000 });
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    await until(() => sink.frames.length === 1, "the first frame");
    // Many frame intervals pass with no ack: a slow relay, nothing queues.
    await sleep(60);
    expect(sink.frames).toHaveLength(1);
    expect(drivers[0]!.requests).toHaveLength(1);

    viewer.ack();
    await until(() => sink.frames.length === 2, "the frame after the ack");
    viewer.ack();
    await until(() => sink.frames.length === 3, "the next frame");
    viewer.detach();
    hub.dispose();
  });

  it("stops capturing the moment the viewer leaves, and shuts the capture process after the linger", async () => {
    const { hub, drivers, logs } = setup();
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    await until(() => sink.frames.length === 1, "the first frame");
    viewer.ack();
    await until(() => sink.frames.length === 2, "a second frame");
    viewer.detach();
    const captured = drivers[0]!.requests.length;
    await sleep(25);
    expect(drivers[0]!.requests.length).toBeLessThanOrEqual(captured + 1);
    expect(hub.viewerCount).toBe(0);
    await until(() => drivers[0]!.disposed, "the capture process to stop");
    expect(hub.captureRunning).toBe(false);
    expect(logs.some((line) => line.includes("left after"))).toBe(true);
    expect(logs.at(-1)).toContain("capture process stopped");
  });

  it("reuses the capture process when a viewer comes back within the linger", async () => {
    const { hub, drivers } = setup({ ...FAST, lingerMs: 500 });
    const first = hub.attach(new RecordingSink());
    await until(() => drivers.length === 1 && drivers[0]!.requests.length > 0, "a capture");
    first.detach();
    const sink = new RecordingSink();
    const second = hub.attach(sink);
    await until(() => sink.frames.length === 1, "a frame for the returning viewer");
    expect(drivers).toHaveLength(1);
    expect(drivers[0]!.disposed).toBe(false);
    second.detach();
    hub.dispose();
    expect(drivers[0]!.disposed).toBe(true);
  });

  it("shares one capture process between two viewers and keeps it while one still watches", async () => {
    const { hub, drivers } = setup();
    const phone = new RecordingSink();
    const laptop = new RecordingSink();
    const a = hub.attach(phone);
    const b = hub.attach(laptop);
    await until(() => phone.frames.length === 1 && laptop.frames.length === 1, "both frames");
    expect(drivers).toHaveLength(1);
    a.detach();
    await sleep(60);
    expect(drivers[0]!.disposed).toBe(false);
    b.ack();
    await until(() => laptop.frames.length === 2, "the remaining viewer's next frame");
    b.detach();
    hub.dispose();
  });

  it("says the PC is locked instead of sending frames, once, and resumes with a fresh frame", async () => {
    const { hub, drivers } = setup();
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    await until(() => drivers.length === 1, "the capture process");
    drivers[0]!.screen = "locked";
    viewer.ack();
    await until(() => sink.states.includes("locked"), "the locked state");
    const frames = sink.frames.length;
    await sleep(40);
    expect(sink.frames.length).toBe(frames);
    expect(sink.states.filter((state) => state === "locked")).toHaveLength(1);

    drivers[0]!.screen = "still";
    await until(() => sink.states.at(-1) === "live", "live again");
    await until(() => sink.frames.length === frames + 1, "a frame after unlock");
    // After a lock the viewer always gets a full frame, never "unchanged".
    const unlockRequest = drivers[0]!.requests.findLast(
      (request) => request.lastHash === undefined,
    );
    expect(unlockRequest).toBeDefined();
    viewer.detach();
    hub.dispose();
  });

  it("skips unchanged frames: a still screen sends one frame and no more bytes", async () => {
    const { hub, drivers } = setup({ ...FAST, ackTimeoutMs: 5_000 }, "still");
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    await until(() => sink.frames.length === 1, "a frame");
    viewer.ack();
    await until(() => viewer.stats().unchanged >= 4, "a few unchanged captures");
    // Unchanged frames need no ack either: nothing was sent.
    expect(sink.frames).toHaveLength(1);
    expect(drivers[0]!.requests.at(-1)?.lastHash).toBe("h-still");
    viewer.detach();
    hub.dispose();
  });

  it("steps frames down when acks are slow or lost, capped to the viewer's box", async () => {
    const { hub, drivers } = setup({ ...FAST, ackTimeoutMs: 200 });
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    viewer.setViewport(3200, 1290);
    // The capture that started on attach predates the box: ack it.
    await until(() => sink.frames.length === 1, "the first frame");
    viewer.ack();
    await until(() => sink.frames.length === 2, "a frame for the viewer's box");
    const first = drivers[0]!.requests[1]!;
    // The long edge never exceeds the cap, whatever the viewer asks for.
    expect(Number(first.maxWidth)).toBe(PERSONAL_DESKTOP_VIEW_MAX_EDGE);
    expect(first.quality).toBe(80);
    // No ack: the frame is taken as lost and the next one is smaller.
    await until(
      () => drivers[0]!.requests.some((request) => request.quality === 70),
      "a capture after an ack timeout",
    );
    const second = drivers[0]!.requests.find((request) => request.quality === 70)!;
    expect(Number(second.maxWidth)).toBeLessThan(Number(first.maxWidth));
    viewer.detach();
    hub.dispose();
  });

  it("sends a phone's full box past the old 1280 cap", async () => {
    const { hub, drivers } = setup(FAST, "monitor");
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    // An iPhone 14 Pro Max in landscape, full screen.
    viewer.setViewport(2796, 1290, { x: 0, y: 0, width: 1, height: 1 });
    await until(() => sink.frames.length === 1, "a frame");
    viewer.ack();
    await until(() => sink.frames.length === 2, "the landscape frame");
    expect(drivers[0]!.requests[1]).toMatchObject({ maxWidth: 2560, maxHeight: 1290 });
    const frame = decodePersonalDesktopFrame(sink.frames[1]!);
    expect(frame?.meta.width).toBe(2064);
    expect(frame?.meta.height).toBe(1290);
    expect(frame?.meta.region).toEqual({ x: 0, y: 0, width: 3072, height: 1920 });
    viewer.detach();
    hub.dispose();
  });

  it("captures just the zoomed-in region, at the monitor's own pixels", async () => {
    const { hub, drivers } = setup({ ...FAST, ackTimeoutMs: 5_000 }, "monitor");
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    viewer.setViewport(1290, 730, { x: 0, y: 0, width: 1, height: 1 });
    await until(() => sink.frames.length === 1, "the whole-monitor frame");
    const whole = decodePersonalDesktopFrame(sink.frames[0]!)!;
    // Unzoomed on a phone: the monitor shrunk into the box.
    expect(whole.meta.width).toBeLessThanOrEqual(1290);
    expect(whole.meta.region).toEqual({ x: 0, y: 0, width: 3072, height: 1920 });

    // Zoomed 3x into the middle: the region is a third of the monitor.
    viewer.setViewport(1290, 730, { x: 1 / 3, y: 1 / 3, width: 1 / 3, height: 1 / 3 });
    viewer.ack();
    await until(() => sink.frames.length === 2, "the region frame");
    const request = drivers[0]!.requests.at(-1)!;
    expect(request).toMatchObject({
      regionX: 1024,
      regionY: 640,
      regionWidth: 1024,
      regionHeight: 640,
    });
    // A new region never skips as "unchanged" against the old frame.
    expect(request.lastHash).toBeUndefined();
    const zoomed = decodePersonalDesktopFrame(sink.frames[1]!)!;
    expect(zoomed.meta.region).toEqual({ x: 1024, y: 640, width: 1024, height: 640 });
    // Native resolution: one frame pixel per monitor pixel, not an enlarged
    // 1/3 of a 1168 px frame (389 px across).
    expect(zoomed.meta.width).toBe(zoomed.meta.region.width);
    expect(zoomed.meta.height).toBe(zoomed.meta.region.height);
    expect(zoomed.meta.screenWidth).toBe(3072);
    viewer.detach();
    hub.dispose();
  });

  it("keeps sending plain frames to a viewer that never names a region", async () => {
    const { hub } = setup(FAST, "monitor");
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    viewer.setViewport(1290, 730);
    await until(() => sink.frames.length === 1, "a frame");
    expect(decodePersonalBrowserFrame(sink.frames[0]!)).not.toBeNull();
    expect(decodePersonalDesktopFrame(sink.frames[0]!)).toBeNull();
    viewer.detach();
    hub.dispose();
  });

  it("maps a region to monitor pixels: outwards, a minimum size, kept on the monitor", () => {
    expect(regionPixels({ x: 0.5, y: 0.5, width: 0.25, height: 0.25 }, MONITOR)).toEqual({
      x: 1536,
      y: 960,
      width: 768,
      height: 480,
    });
    // A sliver near the right edge grows to the minimum and stays on screen.
    expect(regionPixels({ x: 0.999, y: 0, width: 0.001, height: 1 }, MONITOR)).toEqual({
      x: 3072 - 64,
      y: 0,
      width: 64,
      height: 1920,
    });
    // Fractions that do not land on pixels round outwards.
    expect(regionPixels({ x: 0.1, y: 0.1, width: 0.3001, height: 0.3001 }, MONITOR)).toEqual({
      x: 307,
      y: 192,
      width: 923,
      height: 577,
    });
  });

  it("reports a capture failure as unavailable and keeps retrying", async () => {
    const { hub, drivers } = setup();
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    await until(() => drivers.length === 1, "the capture process");
    drivers[0]!.screen = "broken";
    viewer.ack();
    await until(
      () => sink.states.some((state) => state.startsWith("unavailable")),
      "the unavailable state",
    );
    const attempts = drivers[0]!.requests.length;
    await until(() => drivers[0]!.requests.length > attempts + 1, "retries");
    drivers[0]!.screen = "changing";
    await until(() => sink.states.at(-1) === "live", "recovery");
    viewer.detach();
    hub.dispose();
  });

  it("captures faster while the viewer controls the PC, and back to normal after", async () => {
    const { hub, drivers, logs } = setup(
      {
        ...FAST,
        frameIntervalMs: 200,
        idleIntervalMs: 200,
        controlFrameIntervalMs: 10,
        controlIdleIntervalMs: 10,
        controlMaxCaptureDuty: 1,
        nudgeDelayMs: 0,
      },
      "still",
    );
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    await until(() => sink.frames.length === 1, "the first frame");
    viewer.ack();
    await sleep(150);
    const watching = drivers[0]!.requests.length;
    expect(watching).toBeLessThanOrEqual(2);

    viewer.setControl(true);
    await sleep(150);
    const controlling = drivers[0]!.requests.length - watching;
    expect(controlling).toBeGreaterThanOrEqual(5);
    // Still one frame and no more bytes: the screen did not change.
    expect(sink.frames).toHaveLength(1);

    viewer.setControl(false);
    await sleep(20);
    const before = drivers[0]!.requests.length;
    await sleep(150);
    expect(drivers[0]!.requests.length - before).toBeLessThanOrEqual(1);
    expect(logs.some((line) => line.endsWith("took remote control"))).toBe(true);
    expect(logs.some((line) => line.endsWith("left remote control"))).toBe(true);
    viewer.detach();
    hub.dispose();
  });

  it("captures soon after an input even while backed off on a still screen", async () => {
    const { hub, drivers } = setup(
      {
        ...FAST,
        frameIntervalMs: 1_000,
        idleIntervalMs: 1_000,
        controlFrameIntervalMs: 1_000,
        controlIdleIntervalMs: 1_000,
        nudgeDelayMs: 5,
      },
      "still",
    );
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    await until(() => sink.frames.length === 1, "the first frame");
    viewer.ack();
    await sleep(30);
    const count = drivers[0]!.requests.length;
    viewer.nudge();
    // Half the control spacing after the last capture at the earliest, not a whole second.
    await until(() => drivers[0]!.requests.length > count, "a capture after the input", 900);
    viewer.detach();
    hub.dispose();
  });

  it("an input while a frame is in flight waits for its ack before the next capture", async () => {
    const { hub, drivers } = setup({
      ...FAST,
      frameIntervalMs: 1_000,
      controlFrameIntervalMs: 1_000,
      ackTimeoutMs: 5_000,
      nudgeDelayMs: 0,
    });
    const sink = new RecordingSink();
    const viewer = hub.attach(sink);
    await until(() => sink.frames.length === 1, "the first frame");
    viewer.nudge();
    await sleep(40);
    // Still one frame in flight: the nudge did not break backpressure.
    expect(drivers[0]!.requests).toHaveLength(1);
    viewer.ack();
    await until(() => sink.frames.length === 2, "the frame after the ack", 900);
    viewer.detach();
    hub.dispose();
  });
});
