/**
 * Always-on telemetry for the shared-browser live view, one `ViewerTelemetry`
 * per attached viewer. It exists to say where the lag a phone feels comes
 * from: Chrome's frame rate, the pacing in `ViewerFlow`, the phone's
 * acknowledgements, the input path (taps and scrolls waiting in line, the CDP
 * calls they cost) or the phone itself.
 *
 * Every five seconds the service writes one `browser-stream` log line per
 * viewer from `flush`, and one `browser-stream summary` line when the viewer
 * detaches. Numbers only: counts, rates, bytes and millisecond percentiles.
 * No page content, URLs, titles, coordinates or typed text ever reach it; an
 * input is classified by its type alone. Percentiles come from the last few
 * hundred samples of the window.
 *
 * Kill switch: `T3CODE_PERSONAL_BROWSER_STREAM_TELEMETRY=off` (server
 * environment) stops it, and then no viewer has a `ViewerTelemetry`.
 */
import type { ViewerFlowBlock, ViewerFlowObserver } from "./viewerFlow.ts";

export const STREAM_TELEMETRY_FLUSH_MS = 5_000;
/** Samples kept per metric in a window, and over the viewer's whole stay. */
/** A window is cut into slices this long to find how much of it the page was moving. */
const ACTIVE_BUCKET_MS = 250;
const WINDOW_SAMPLES = 512;
const TOTAL_SAMPLES = 2_048;
/** Inputs waiting for a frame that shows their effect; a flood cannot grow it. */
const MAX_AWAITING_FRAME = 64;

export type StreamInputKind = "tap" | "wheel" | "key" | "other";

/** A ring of the latest samples with percentile reads. */
class Samples {
  private readonly values: number[] = [];
  private next = 0;
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(value: number): void {
    if (this.values.length < this.capacity) this.values.push(value);
    else {
      this.values[this.next] = value;
      this.next = (this.next + 1) % this.capacity;
    }
  }

  get size(): number {
    return this.values.length;
  }

  percentiles(): { readonly p50: number; readonly p95: number; readonly max: number } | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (fraction: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
    return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
  }
}

/** Counters and sample series, kept twice: for the current window and for the whole stay. */
class Tally {
  readonly counts = new Map<string, number>();
  private readonly series = new Map<string, Samples>();
  private readonly capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  count(name: string, amount = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + amount);
  }

  max(name: string, value: number): void {
    if (value > (this.counts.get(name) ?? 0)) this.counts.set(name, value);
  }

  sample(name: string, value: number): void {
    let samples = this.series.get(name);
    if (samples === undefined) {
      samples = new Samples(this.capacity);
      this.series.set(name, samples);
    }
    samples.push(value);
  }

  get(name: string): number {
    return this.counts.get(name) ?? 0;
  }

  percentiles(name: string) {
    return this.series.get(name)?.percentiles() ?? null;
  }
}

const round = (value: number, digits = 1) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** `{ p50, p95, n }` in whole-ish milliseconds, or null when nothing was measured. */
const summarise = (tally: Tally, name: string) => {
  const stats = tally.percentiles(name);
  return stats === null
    ? null
    : { p50: round(stats.p50), p95: round(stats.p95), n: tally.get(`n:${name}`) };
};

export type StreamTelemetryLine = Readonly<Record<string, unknown>>;

export interface ViewerTelemetryOptions {
  readonly viewerId: number;
  readonly canOperate: boolean;
  readonly now?: () => number;
}

export class ViewerTelemetry implements ViewerFlowObserver {
  private readonly now: () => number;
  private window = new Tally(WINDOW_SAMPLES);
  private readonly total = new Tally(TOTAL_SAMPLES);
  private windowStartedAt: number;
  private readonly startedAt: number;
  private readonly awaitingFrame: Array<{
    readonly kind: StreamInputKind;
    readonly arrivedAt: number;
    readonly dispatchedAt: number;
  }> = [];
  private lastPhone: StreamTelemetryLine | null = null;
  private lastOfferedAt: number | null = null;
  /** Quarter-seconds in which anything happened, so rates can be read over the time the page moved. */
  private windowActive = new Set<number>();
  private readonly totalActive = new Set<number>();
  private lastSentAt: number | null = null;
  /** Whether the live view is in its rougher "moving" picture (adaptive JPEG), and since when. */
  private moving = false;
  private movingSince: number | null = null;
  private readonly options: ViewerTelemetryOptions;

  constructor(options: ViewerTelemetryOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.startedAt = this.now();
    this.windowStartedAt = this.startedAt;
  }

  // -- recording ----------------------------------------------------------

  private mark(at: number): void {
    const bucket = Math.floor(at / ACTIVE_BUCKET_MS);
    this.windowActive.add(bucket);
    this.totalActive.add(bucket);
  }

  private count(name: string, amount = 1): void {
    this.window.count(name, amount);
    this.total.count(name, amount);
  }

  private sample(name: string, value: number): void {
    this.window.sample(name, value);
    this.total.sample(name, value);
    this.window.count(`n:${name}`);
    this.total.count(`n:${name}`);
  }

  /** Adds the time spent in the moving picture up to `at` to the counters. */
  private accrueMoving(at: number): void {
    if (this.movingSince === null) return;
    this.count("movingMs", Math.max(0, at - this.movingSince));
    this.movingSince = at;
  }

  /** The live view went to its rougher picture (`moving`) or back to the sharp one. */
  motion(moving: boolean): void {
    if (moving === this.moving) return;
    const at = this.now();
    this.accrueMoving(at);
    this.moving = moving;
    this.movingSince = moving ? at : null;
    if (moving) this.count("motionSwitches");
  }

  /** Chrome produced a frame (whether or not it could be shown). */
  chromeFrame(): void {
    this.count("chromeFrames");
  }

  /** Chrome's ack for a frame was held until a phone is done with it (counted when the frame arrives). */
  chromeHeld(): void {
    this.count("chromeHeld");
  }

  /** How long Chrome's ack for a frame was held, once released. */
  chromeHold(ms: number, capped: boolean): void {
    this.sample("chromeHoldMs", ms);
    if (capped) this.count("chromeHoldCapped");
  }

  /** A frame was withheld (a saved password is on screen). */
  frameHidden(): void {
    this.count("framesHidden");
  }

  offered(replaced: boolean): void {
    const at = this.now();
    this.mark(at);
    if (this.lastOfferedAt !== null && at - this.lastOfferedAt < 1_000) {
      this.sample("offerGapMs", at - this.lastOfferedAt);
    }
    this.lastOfferedAt = at;
    this.count("offered");
    if (replaced) this.count("replaced");
  }

  sent(info: {
    readonly bytes: number;
    readonly offeredAt: number;
    readonly sentAt: number;
    readonly queuedMs: number;
    readonly lateMs: number;
  }): void {
    this.mark(info.sentAt);
    this.count("sent");
    this.sample("lateMs", info.lateMs);
    // Spacing of sends; a pause in the page's changes is not a gap worth reading.
    if (this.lastSentAt !== null && info.sentAt - this.lastSentAt < 1_000) {
      this.sample("sendGapMs", info.sentAt - this.lastSentAt);
    }
    this.lastSentAt = info.sentAt;
    this.count("bytes", info.bytes);
    // Which picture this frame was: the sizes of the two, and the rate while moving.
    this.count(this.moving ? "sentMoving" : "sentStill");
    this.count(this.moving ? "bytesMoving" : "bytesStill", info.bytes);
    this.sample("queuedMs", info.queuedMs);
    // Inputs whose effect this frame can show: it arrived after they were dispatched.
    const shown = this.awaitingFrame.filter((entry) => entry.dispatchedAt <= info.offeredAt);
    if (shown.length === 0) return;
    for (const entry of shown) this.awaitingFrame.splice(this.awaitingFrame.indexOf(entry), 1);
    this.sample("inputToFrameMs", info.sentAt - shown[0]!.arrivedAt);
    const tap = shown.find((entry) => entry.kind === "tap");
    if (tap !== undefined) this.sample("tapToFrameMs", info.sentAt - tap.arrivedAt);
    const wheel = shown.find((entry) => entry.kind === "wheel");
    if (wheel !== undefined) this.sample("wheelToFrameMs", info.sentAt - wheel.arrivedAt);
  }

  blocked(reason: ViewerFlowBlock): void {
    this.count(`blocked:${reason}`);
  }

  ackRtt(ms: number): void {
    this.sample("ackRttMs", ms);
  }

  ackStalled(): void {
    this.count("ackStalls");
  }

  /** The route queued an input behind others; `depth` includes it. */
  inputQueued(depth: number): void {
    this.window.max("inputQueueMax", depth);
    this.total.max("inputQueueMax", depth);
  }

  /** One input finished. `waitMs` is how long it waited in line, `handleMs` how long it took. */
  inputHandled(info: {
    readonly kind: StreamInputKind;
    readonly arrivedAt: number;
    readonly waitMs: number;
    readonly handleMs: number;
    readonly failed: boolean;
  }): void {
    this.mark(this.now());
    this.count(`input:${info.kind}`);
    if (info.failed) this.count("inputFailed");
    this.sample("inputWaitMs", info.waitMs);
    this.sample(`handle:${info.kind}Ms`, info.handleMs);
    if (info.failed) return;
    this.awaitingFrame.push({
      kind: info.kind,
      arrivedAt: info.arrivedAt,
      dispatchedAt: this.now(),
    });
    if (this.awaitingFrame.length > MAX_AWAITING_FRAME) this.awaitingFrame.shift();
  }

  /** A wheel message was merged into the one before it while the worker was busy. */
  wheelMerged(): void {
    this.count("wheelMerged");
  }

  /** A tap waited for the page to apply the scroll before it; `capped` when the page ran out the cap. */
  scrollSettle(waitedMs: number, capped: boolean): void {
    this.sample("settleMs", waitedMs);
    if (capped) this.count("settleCapped");
  }

  /** One CDP call inside an input (`move`, `wheel`, `click`). */
  cdp(call: string, ms: number): void {
    this.sample(`cdp:${call}Ms`, ms);
  }

  /** What the phone itself reported (already checked against the schema). */
  phone(stats: StreamTelemetryLine): void {
    this.lastPhone = stats;
  }

  // -- reporting ----------------------------------------------------------

  private static describe(tally: Tally, seconds: number, activeBuckets: number) {
    const rate = (name: string) => round(tally.get(name) / seconds, 2);
    // Scrolling comes in bursts, so a rate over the whole window understates what a burst gets.
    const activeSeconds = Math.max(
      ACTIVE_BUCKET_MS / 1_000,
      (activeBuckets * ACTIVE_BUCKET_MS) / 1_000,
    );
    const activeRate = (name: string) => round(tally.get(name) / activeSeconds, 2);
    const sent = tally.get("sent");
    const movingSeconds = tally.get("movingMs") / 1_000;
    const average = (count: string, bytes: string) =>
      tally.get(count) === 0 ? 0 : Math.round(tally.get(bytes) / tally.get(count));
    return {
      seconds: round(seconds),
      activeSeconds: round(activeSeconds, 2),
      chrome: {
        fps: rate("chromeFrames"),
        fpsActive: activeRate("chromeFrames"),
        hiddenPerS: rate("framesHidden"),
        heldPct:
          tally.get("chromeFrames") === 0
            ? 0
            : round((100 * tally.get("chromeHeld")) / tally.get("chromeFrames"), 0),
        holdMs: summarise(tally, "chromeHoldMs"),
        holdCapped: tally.get("chromeHoldCapped"),
      },
      // Adaptive JPEG: how long the picture was rough, how big each kind of frame was, and the
      // send rate while it was rough.
      adaptive: {
        movingS: round(movingSeconds),
        switches: tally.get("motionSwitches"),
        sentMoving: tally.get("sentMoving"),
        sentPerMovingS: movingSeconds > 0 ? round(tally.get("sentMoving") / movingSeconds, 2) : 0,
        avgBytesMoving: average("sentMoving", "bytesMoving"),
        sentStill: tally.get("sentStill"),
        avgBytesStill: average("sentStill", "bytesStill"),
      },
      frames: {
        offeredPerS: rate("offered"),
        sentPerS: rate("sent"),
        offeredPerActiveS: activeRate("offered"),
        sentPerActiveS: activeRate("sent"),
        replaced: tally.get("replaced"),
        avgBytes: sent === 0 ? 0 : Math.round(tally.get("bytes") / sent),
        queuedMs: summarise(tally, "queuedMs"),
        // Spacing of Chrome's frames, of our writes, and how late a write was after its slot opened:
        // sparse arrivals, or a writer that wakes late, are told apart here.
        offerGapMs: summarise(tally, "offerGapMs"),
        sendGapMs: summarise(tally, "sendGapMs"),
        lateMs: summarise(tally, "lateMs"),
        ackRttMs: summarise(tally, "ackRttMs"),
        blocked: {
          fps: tally.get("blocked:fps"),
          ack: tally.get("blocked:ack"),
          socket: tally.get("blocked:socket"),
        },
        ackStalls: tally.get("ackStalls"),
      },
      input: {
        perS: {
          tap: rate("input:tap"),
          wheel: rate("input:wheel"),
          key: rate("input:key"),
          other: rate("input:other"),
        },
        failed: tally.get("inputFailed"),
        wheelMerged: tally.get("wheelMerged"),
        settleMs: summarise(tally, "settleMs"),
        settleCapped: tally.get("settleCapped"),
        queueMax: tally.get("inputQueueMax"),
        waitMs: summarise(tally, "inputWaitMs"),
        handleMs: {
          tap: summarise(tally, "handle:tapMs"),
          wheel: summarise(tally, "handle:wheelMs"),
          key: summarise(tally, "handle:keyMs"),
          other: summarise(tally, "handle:otherMs"),
        },
        cdpMs: {
          move: summarise(tally, "cdp:moveMs"),
          wheel: summarise(tally, "cdp:wheelMs"),
          click: summarise(tally, "cdp:clickMs"),
        },
        toFrameMs: summarise(tally, "inputToFrameMs"),
        tapToFrameMs: summarise(tally, "tapToFrameMs"),
        wheelToFrameMs: summarise(tally, "wheelToFrameMs"),
      },
    };
  }

  /** True when nothing happened in the window, so there is nothing worth a log line. */
  private get quiet(): boolean {
    return (
      this.window.get("chromeFrames") === 0 &&
      this.window.get("sent") === 0 &&
      this.window.get("input:tap") +
        this.window.get("input:wheel") +
        this.window.get("input:key") +
        this.window.get("input:other") ===
        0 &&
      this.lastPhone === null
    );
  }

  /** The window's line, then a fresh window. Null when the window was entirely quiet. */
  flush(extra: StreamTelemetryLine = {}): StreamTelemetryLine | null {
    const at = this.now();
    this.accrueMoving(at);
    const seconds = Math.max(0.001, (at - this.windowStartedAt) / 1_000);
    const quiet = this.quiet;
    const line = quiet
      ? null
      : {
          viewer: this.options.viewerId,
          operate: this.options.canOperate,
          ...extra,
          ...ViewerTelemetry.describe(this.window, seconds, this.windowActive.size),
          ...(this.lastPhone === null ? {} : { phone: this.lastPhone }),
        };
    this.window = new Tally(WINDOW_SAMPLES);
    this.windowActive = new Set();
    this.windowStartedAt = at;
    this.lastPhone = null;
    return line;
  }

  /** Totals for the whole stay, written when the viewer detaches. */
  summary(extra: StreamTelemetryLine = {}): StreamTelemetryLine {
    this.accrueMoving(this.now());
    const seconds = Math.max(0.001, (this.now() - this.startedAt) / 1_000);
    return {
      viewer: this.options.viewerId,
      operate: this.options.canOperate,
      ...extra,
      ...ViewerTelemetry.describe(this.total, seconds, this.totalActive.size),
    };
  }
}
