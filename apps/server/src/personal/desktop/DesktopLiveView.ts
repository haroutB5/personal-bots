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
 */
// @effect-diagnostics globalTimers:off - capture pacing on a callback-based child process.
// @effect-diagnostics globalDate:off - pacing uses a plain millisecond clock.
import {
  clampPersonalDesktopViewBox,
  encodePersonalBrowserFrame,
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
  /** The box the client shows frames in, in device pixels. */
  readonly setViewport: (width: number, height: number) => void;
  readonly detach: () => void;
  readonly stats: () => LiveViewStats;
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
};

/** Unchanged captures in a row before the rate backs off to the idle spacing. */
const STILL_AFTER = 3;
/** Box scale and JPEG quality per adaptation level: full, then two steps down. */
export const LIVE_VIEW_LEVELS: ReadonlyArray<{ readonly scale: number; readonly quality: number }> =
  [
    { scale: 1, quality: 70 },
    { scale: 0.75, quality: 60 },
    { scale: 0.5, quality: 50 },
  ];
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
      setViewport: (width, height) => loop.setViewport(width, height),
      stats: () => loop.stats(),
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
  private lastHash: string | null = null;
  private inFlight = false;
  private sentAt = 0;
  private level = 0;
  private fastAcks = 0;
  private still = 0;
  private lastState: string | null = null;
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

  setViewport(width: number, height: number): void {
    this.box = clampPersonalDesktopViewBox({ width, height });
  }

  close(): void {
    this.closed = true;
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
      const wait = nextAt - this.now();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      const started = this.now();
      const level = LIVE_VIEW_LEVELS[this.level]!;
      let reply: Record<string, unknown>;
      try {
        reply = await this.hub.capture({
          maxWidth: Math.max(64, Math.round(this.box.width * level.scale)),
          maxHeight: Math.max(64, Math.round(this.box.height * level.scale)),
          quality: level.quality,
          ...(this.lastHash === null ? {} : { lastHash: this.lastHash }),
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
      this.setState("live");
      // Whatever the target rate, a slow capture spaces the next one out.
      const spacing = Math.max(this.timing.frameIntervalMs, elapsed / this.timing.maxCaptureDuty);
      if (reply.unchanged === true) {
        this.unchanged += 1;
        this.still += 1;
        nextAt =
          started +
          (this.still >= STILL_AFTER ? Math.max(spacing, this.timing.idleIntervalMs) : spacing);
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
      const frame = encodePersonalBrowserFrame(Buffer.from(data, "base64"), {
        width,
        height,
        deviceScaleFactor: 1,
      });
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
