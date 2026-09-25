/**
 * The app's live view of the PC: a low-rate JPEG stream of the primary
 * monitor for whoever has the Desktop view open.
 *
 * - **Only while watched.** Each open viewer socket runs one capture loop; the
 *   capture process starts with the first viewer and is shut down
 *   {@link LiveViewTiming.lingerMs} after the last one leaves. Nobody
 *   watching costs nothing.
 * - **Never in a bot's way.** Captures go to a separate capture-only helper
 *   process (`RunCapture`: no input hooks, no overlay), so a frame grab can
 *   never queue behind or reorder the holder's clicks and typing. The overlay
 *   is excluded from every capture by Windows itself.
 * - **Backpressure.** One frame in flight per viewer: the next capture waits
 *   for the client's Ack (or an ack timeout), so a slow relay never builds a
 *   queue. Slow acks also step the frame size and quality down.
 * - **Cheap when still.** The helper hashes the scaled pixels; an unchanged
 *   frame costs a capture but no encode and no bytes, and the rate backs off.
 * - **Locked PC.** Nothing is captured; the viewer is told `locked`.
 * - **Zoom.** A viewer that names a region of the monitor (it zoomed in) gets
 *   just that region, scaled to its box but never up, so zoomed text arrives
 *   at the PC's own resolution instead of as an enlarged whole-screen frame.
 *   Such a viewer gets region frames ({@link encodePersonalDesktopFrame}) that
 *   say what they show; one that never names a region gets plain frames.
 * - **Remote control.** While a viewer controls the PC it gets a faster rate
 *   ({@link LiveViewTiming.controlFrameIntervalMs}) and a capture right after
 *   each input (`nudge`), still one frame in flight.
 */
// @effect-diagnostics globalTimers:off - capture pacing on a callback-based child process.
// @effect-diagnostics globalDate:off - pacing uses a plain millisecond clock.
import {
  clampPersonalDesktopViewBox,
  encodePersonalBrowserFrame,
  encodePersonalDesktopFrame,
  type PersonalDesktopViewRegion,
  type PersonalDesktopViewState,
} from "@t3tools/contracts";

import { DesktopHelperError } from "./DesktopHelper.ts";

/** The capture helper as the hub uses it: the real process, or a fake in tests. */
export interface DesktopCaptureDriver {
  readonly request: (
    cmd: string,
    params?: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  readonly dispose: () => void;
}

/** Where one viewer's frames and state messages go (its socket's outbox). */
export interface LiveViewSink {
  readonly frame: (bytes: Uint8Array) => void;
  readonly state: (state: PersonalDesktopViewState, detail?: string) => void;
}

export interface LiveViewStats {
  readonly frames: number;
  readonly bytes: number;
  readonly captures: number;
  readonly unchanged: number;
  readonly locked: number;
  readonly captureMsTotal: number;
  readonly startedAt: number;
}

export interface LiveViewer {
  /** The client drew the last frame. */
  readonly ack: () => void;
  /**
   * The box the client shows frames in, in device pixels, and the part of the
   * monitor it shows there (absent: a client that only knows whole frames).
   */
  readonly setViewport: (width: number, height: number, region?: PersonalDesktopViewRegion) => void;
  readonly detach: () => void;
  readonly stats: () => LiveViewStats;
  /** This viewer controls the PC (faster frames) or went back to watching. */
  readonly setControl: (on: boolean) => void;
  /** An input just went to the PC: capture again soon, even on a still screen. */
  readonly nudge: () => void;
}

export interface LiveViewTiming {
  /** Spacing between captures while the screen changes (2 fps). */
  readonly frameIntervalMs: number;
  /** Spacing once the screen has been still for a few captures. */
  readonly idleIntervalMs: number;
  readonly lockedIntervalMs: number;
  readonly errorIntervalMs: number;
  /** A frame never acknowledged this long is taken as lost. */
  readonly ackTimeoutMs: number;
  /** How long the capture process outlives the last viewer (a quick tab switch reuses it). */
  readonly lingerMs: number;
  /** Captures may use at most this share of wall time, whatever the target rate. */
  readonly maxCaptureDuty: number;
  readonly captureTimeoutMs: number;
  /** Spacing while the viewer controls the PC (about 6 fps). */
  readonly controlFrameIntervalMs: number;
  /** Still-screen spacing while in control. */
  readonly controlIdleIntervalMs: number;
  /** Capture duty cap while in control. */
  readonly controlMaxCaptureDuty: number;
  /** How soon after an input the next capture starts (the screen reacts first). */
  readonly nudgeDelayMs: number;
}

export const DEFAULT_LIVE_VIEW_TIMING: LiveViewTiming = {
  frameIntervalMs: 500,
  idleIntervalMs: 1_000,
  lockedIntervalMs: 2_000,
  errorIntervalMs: 3_000,
  ackTimeoutMs: 10_000,
  lingerMs: 20_000,
  maxCaptureDuty: 0.35,
  captureTimeoutMs: 10_000,
  controlFrameIntervalMs: 150,
  controlIdleIntervalMs: 300,
  controlMaxCaptureDuty: 0.6,
  nudgeDelayMs: 90,
};

/** Unchanged captures in a row before the rate backs off to the idle spacing. */
const STILL_AFTER = 3;
/** Box scale and JPEG quality per adaptation level: full, then two steps down. */
export const LIVE_VIEW_LEVELS: ReadonlyArray<{ readonly scale: number; readonly quality: number }> =
  [
    { scale: 1, quality: 80 },
    { scale: 0.75, quality: 70 },
    { scale: 0.5, quality: 55 },
  ];
/** The smallest region edge ever captured, in monitor pixels. */
const MIN_REGION_EDGE = 64;

export interface PixelRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A region given as fractions of the monitor, in monitor pixels: rounded
 * outwards so the viewer's whole visible area is covered, at least
 * {@link MIN_REGION_EDGE} a side, and kept on the monitor.
 */
export function regionPixels(
  region: PersonalDesktopViewRegion,
  screen: { readonly width: number; readonly height: number },
): PixelRegion {
  const axis = (start: number, size: number, total: number) => {
    const from = Math.max(0, Math.floor(start * total));
    const to = Math.min(total, Math.ceil((start + size) * total));
    const length = Math.min(total, Math.max(MIN_REGION_EDGE, to - from));
    return { from: Math.max(0, Math.min(total - length, from)), length };
  };
  const x = axis(region.x, region.width, screen.width);
  const y = axis(region.y, region.height, screen.height);
  return { x: x.from, y: y.from, width: x.length, height: y.length };
}

const isWholeMonitor = (region: PersonalDesktopViewRegion) =>
  region.x <= 0 && region.y <= 0 && region.x + region.width >= 1 && region.y + region.height >= 1;

const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
/** An ack slower than this steps the level down (smaller, lower quality frames). */
export const SLOW_ACK_MS = 1_500;
/** This many acks in a row faster than {@link FAST_ACK_MS} step it back up. */
const FAST_ACKS_TO_RECOVER = 6;
const FAST_ACK_MS = 500;

export interface DesktopLiveViewHubOptions {
  readonly createDriver: () => DesktopCaptureDriver;
  readonly timing?: Partial<LiveViewTiming>;
  readonly now?: () => number;
  /** One line per lifecycle event, for the server log. */
  readonly log?: (message: string) => void;
}

const describeFailure = (error: unknown): string =>
  error instanceof DesktopHelperError || error instanceof Error ? error.message : String(error);

export class DesktopLiveViewHub {
  private readonly timing: LiveViewTiming;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly createDriver: () => DesktopCaptureDriver;
  private readonly viewers = new Set<ViewerLoop>();
  private driver: DesktopCaptureDriver | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private disposed = false;

  constructor(options: DesktopLiveViewHubOptions) {
    this.timing = { ...DEFAULT_LIVE_VIEW_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.createDriver = options.createDriver;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  /** Whether the capture process exists (started and not yet shut down). */
  get captureRunning(): boolean {
    return this.driver !== null;
  }

  attach(sink: LiveViewSink): LiveViewer {
    if (this.lingerTimer !== null) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    const id = ++this.sequence;
    const loop = new ViewerLoop(this, sink, this.timing, this.now);
    this.viewers.add(loop);
    this.log(`desktop live view: viewer ${id} joined (${this.viewers.size} watching)`);
    void loop.run();
    return {
      ack: () => loop.ack(),
      setViewport: (width, height, region) => loop.setViewport(width, height, region),
      stats: () => loop.stats(),
      setControl: (on) => {
        loop.setControl(on);
        this.log(`desktop live view: viewer ${id} ${on ? "took" : "left"} remote control`);
      },
      nudge: () => loop.nudge(),
      detach: () => {
        if (!this.viewers.delete(loop)) return;
        loop.close();
        const stats = loop.stats();
        const seconds = Math.max(0.001, (this.now() - stats.startedAt) / 1000);
        this.log(
          `desktop live view: viewer ${id} left after ${seconds.toFixed(1)} s: ` +
            `${stats.frames} frames, ${Math.round(stats.bytes / 1024)} KB ` +
            `(${Math.round(stats.bytes / 1024 / seconds)} KB/s), ${stats.captures} captures ` +
            `(${stats.unchanged} unchanged), ${stats.locked} locked checks, capture avg ${
              stats.captures === 0 ? 0 : Math.round(stats.captureMsTotal / stats.captures)
            } ms`,
        );
        if (this.viewers.size === 0) this.scheduleShutdown();
      },
    };
  }

  /** One capture on the shared capture process, started on demand. */
  capture(params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    if (this.disposed) return Promise.reject(new DesktopHelperError("unavailable", "Shut down."));
    if (this.driver === null) {
      this.driver = this.createDriver();
      this.log("desktop live view: capture process started");
    }
    return this.driver.request("frame", params, this.timing.captureTimeoutMs);
  }

  private scheduleShutdown(): void {
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.viewers.size > 0) return;
      this.stopDriver();
    }, this.timing.lingerMs);
    this.lingerTimer.unref?.();
  }

  private stopDriver(): void {
    const driver = this.driver;
    this.driver = null;
    if (driver === null) return;
    driver.dispose();
    this.log("desktop live view: capture process stopped (nobody watching)");
  }

  dispose(): void {
    this.disposed = true;
    for (const loop of this.viewers) loop.close();
    this.viewers.clear();
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
    this.stopDriver();
  }
}

class ViewerLoop {
  private closed = false;
  private box = { width: 1280, height: 1280 };
  /** The part of the monitor the viewer shows; null is all of it. */
  private region: PersonalDesktopViewRegion | null = null;
  /** The viewer named a region at least once: it understands region frames. */
  private regionFrames = false;
  /** The monitor's size, from the latest capture. */
  private screen: { width: number; height: number } | null = null;
  private lastHash: string | null = null;
  /** What the capture that produced {@link lastHash} asked for. */
  private lastRequest: string | null = null;
  private inFlight = false;
  private sentAt = 0;
  private level = 0;
  private fastAcks = 0;
  private still = 0;
  private lastState: string | null = null;
  private control = false;
  private nudgeAt: number | null = null;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeResolve: (() => void) | null = null;
  private frames = 0;
  private bytes = 0;
  private captures = 0;
  private unchanged = 0;
  private locked = 0;
  private captureMsTotal = 0;
  private readonly startedAt: number;
  private readonly hub: DesktopLiveViewHub;
  private readonly sink: LiveViewSink;
  private readonly timing: LiveViewTiming;
  private readonly now: () => number;

  constructor(
    hub: DesktopLiveViewHub,
    sink: LiveViewSink,
    timing: LiveViewTiming,
    now: () => number,
  ) {
    this.hub = hub;
    this.sink = sink;
    this.timing = timing;
    this.now = now;
    this.startedAt = now();
  }

  stats(): LiveViewStats {
    return {
      frames: this.frames,
      bytes: this.bytes,
      captures: this.captures,
      unchanged: this.unchanged,
      locked: this.locked,
      captureMsTotal: this.captureMsTotal,
      startedAt: this.startedAt,
    };
  }

  ack(): void {
    if (!this.inFlight) return;
    this.inFlight = false;
    const latency = this.now() - this.sentAt;
    if (latency > SLOW_ACK_MS) this.stepDown();
    else if (latency < FAST_ACK_MS && this.level > 0) {
      this.fastAcks += 1;
      if (this.fastAcks >= FAST_ACKS_TO_RECOVER) {
        this.level -= 1;
        this.fastAcks = 0;
      }
    } else this.fastAcks = 0;
    this.wake();
  }

  setViewport(width: number, height: number, region?: PersonalDesktopViewRegion): void {
    const box = clampPersonalDesktopViewBox({ width, height });
    const next = region === undefined || isWholeMonitor(region) ? null : region;
    const changed =
      box.width !== this.box.width ||
      box.height !== this.box.height ||
      JSON.stringify(next) !== JSON.stringify(this.region);
    this.box = box;
    this.region = next;
    if (region !== undefined) this.regionFrames = true;
    // A new zoom or box should look sharp soon, not at the next idle tick.
    if (changed) this.nudge();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  setControl(on: boolean): void {
    this.control = on;
    this.still = 0;
    if (on) this.nudge();
  }

  nudge(): void {
    this.still = 0;
    this.nudgeAt = this.now() + this.timing.nudgeDelayMs;
    this.wake();
  }

  private stepDown(): void {
    this.fastAcks = 0;
    this.level = Math.min(LIVE_VIEW_LEVELS.length - 1, this.level + 1);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wakeResolve = resolve;
      this.wakeTimer = setTimeout(() => this.wake(), Math.max(0, ms));
    });
  }

  private wake(): void {
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const resolve = this.wakeResolve;
    this.wakeResolve = null;
    resolve?.();
  }

  private setState(state: PersonalDesktopViewState, detail?: string): void {
    const key = `${state}|${detail ?? ""}`;
    if (key === this.lastState) return;
    this.lastState = key;
    this.sink.state(state, detail);
  }

  async run(): Promise<void> {
    let nextAt = this.now();
    while (!this.closed) {
      if (this.inFlight) {
        const left = this.sentAt + this.timing.ackTimeoutMs - this.now();
        if (left > 0) {
          await this.sleep(left);
          continue;
        }
        // Never acknowledged: take it as lost and send smaller frames.
        this.inFlight = false;
        this.stepDown();
      }
      if (this.nudgeAt !== null) {
        // Inputs never pull captures closer than half the control spacing.
        nextAt = Math.min(
          nextAt,
          Math.max(this.nudgeAt, this.lastStartedAt + this.timing.controlFrameIntervalMs / 2),
        );
        this.nudgeAt = null;
      }
      const wait = nextAt - this.now();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      const started = this.now();
      this.lastStartedAt = started;
      const level = LIVE_VIEW_LEVELS[this.level]!;
      // Until the first capture says how big the monitor is, all of it.
      const source =
        this.region === null || this.screen === null
          ? null
          : regionPixels(this.region, this.screen);
      const request = {
        maxWidth: Math.max(64, Math.round(this.box.width * level.scale)),
        maxHeight: Math.max(64, Math.round(this.box.height * level.scale)),
        ...(source === null
          ? {}
          : {
              regionX: source.x,
              regionY: source.y,
              regionWidth: source.width,
              regionHeight: source.height,
            }),
      };
      const requestKey = JSON.stringify(request);
      // "Unchanged" only means something against a frame of the same request:
      // after a zoom or a resize the viewer needs the new pixels whatever they hash to.
      const lastHash = requestKey === this.lastRequest ? this.lastHash : null;
      let reply: Record<string, unknown>;
      try {
        reply = await this.hub.capture({
          ...request,
          quality: level.quality,
          ...(lastHash === null ? {} : { lastHash }),
        });
      } catch (error) {
        if (this.closed) break;
        this.setState("unavailable", describeFailure(error));
        nextAt = started + this.timing.errorIntervalMs;
        continue;
      }
      if (this.closed) break;
      const elapsed = Math.max(0, this.now() - started);
      const captureMs = typeof reply.captureMs === "number" ? reply.captureMs : elapsed;
      if (reply.locked === true) {
        this.locked += 1;
        this.lastHash = null;
        this.still = 0;
        this.setState("locked");
        nextAt = started + this.timing.lockedIntervalMs;
        continue;
      }
      this.captures += 1;
      this.captureMsTotal += captureMs;
      const screenWidth = numberOr(reply.screenWidth, 0);
      const screenHeight = numberOr(reply.screenHeight, 0);
      if (screenWidth > 0 && screenHeight > 0) {
        this.screen = { width: screenWidth, height: screenHeight };
      }
      this.setState("live");
      // Whatever the target rate, a slow capture spaces the next one out.
      const interval = this.control
        ? this.timing.controlFrameIntervalMs
        : this.timing.frameIntervalMs;
      const duty = this.control ? this.timing.controlMaxCaptureDuty : this.timing.maxCaptureDuty;
      const spacing = Math.max(interval, elapsed / duty);
      if (reply.unchanged === true && lastHash !== null) {
        this.unchanged += 1;
        this.still += 1;
        const idle = this.control ? this.timing.controlIdleIntervalMs : this.timing.idleIntervalMs;
        nextAt = started + (this.still >= STILL_AFTER ? Math.max(spacing, idle) : spacing);
        continue;
      }
      this.still = 0;
      const data = typeof reply.data === "string" ? reply.data : "";
      const width = Number(reply.width);
      const height = Number(reply.height);
      if (data.length === 0 || !(width > 0) || !(height > 0)) {
        nextAt = started + spacing;
        continue;
      }
      this.lastHash = typeof reply.hash === "string" ? reply.hash : null;
      this.lastRequest = requestKey;
      const jpeg = Buffer.from(data, "base64");
      const frame = this.regionFrames
        ? encodePersonalDesktopFrame(jpeg, {
            width,
            height,
            // A helper that does not report them captured the whole monitor.
            region: {
              x: numberOr(reply.regionX, 0),
              y: numberOr(reply.regionY, 0),
              width: numberOr(reply.regionWidth, screenWidth > 0 ? screenWidth : width),
              height: numberOr(reply.regionHeight, screenHeight > 0 ? screenHeight : height),
            },
            screenWidth: screenWidth > 0 ? screenWidth : width,
            screenHeight: screenHeight > 0 ? screenHeight : height,
          })
        : encodePersonalBrowserFrame(jpeg, { width, height, deviceScaleFactor: 1 });
      this.inFlight = true;
      this.sentAt = this.now();
      this.frames += 1;
      this.bytes += frame.length;
      this.sink.frame(frame);
      nextAt = started + spacing;
    }
    this.wake();
  }
}
