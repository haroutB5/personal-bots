/**
 * Flow control for one live-viewport socket.
 *
 * Chrome renders screencast frames as fast as its acks allow (up to 60 per
 * second) and the socket writer sends without looking at the link, so on a
 * slow relay every frame queued in the TCP buffers and the phone fell further
 * behind. A `ViewerFlow` holds frames back instead: it keeps only the newest
 * unsent frame (older ones are overwritten, never queued), and releases it
 * only when
 *  - the frame-rate cap allows,
 *  - the socket has handed the previous frame to the network, and
 *  - the phone has acknowledged all but a couple of the frames already sent
 *    (only once it has shown it sends acknowledgements).
 * Control messages never pass through here: they use their own queue.
 */
import * as Effect from "effect/Effect";

export const VIEWER_FLOW_LIMITS = {
  /**
   * Frames per second one viewer is sent, however fast Chrome renders. 30 since 1.60.36
   * (20 before); the ack window, not this, is what a slow link runs into.
   */
  maxFps: 30,
  /** Bytes still waiting in the socket's send buffer above which the next frame waits. */
  backlogLimitBytes: 16 * 1024,
  /** Frames the phone may still owe an acknowledgement for. */
  maxUnackedFrames: 2,
  /** Silence after which unacknowledged frames are presumed lost, so a stuck phone resumes. */
  ackStallMs: 2_000,
  /** How often a blocked frame re-checks the socket's send buffer. */
  backlogPollMs: 10,
  /** The longest Chrome's own frame ack is held back for the viewers to take a frame. */
  chromeHoldMs: 500,
} as const;

export type ViewerFlowStep =
  | { readonly _tag: "Send"; readonly frame: Uint8Array }
  | { readonly _tag: "Wait"; readonly ms: number }
  | { readonly _tag: "Idle" };

export interface ViewerFlowOptions {
  readonly now?: () => number;
  readonly maxFps?: number;
  readonly backlogLimitBytes?: number;
  readonly maxUnackedFrames?: number;
  /**
   * Let one more frame be unacknowledged while the acknowledgements come back about as fast as
   * the quickest ever did (the link is not queueing), so a long round trip does not cap the
   * rate at two frames per round trip. Falls back at once when they slow down.
   */
  readonly adaptiveWindow?: boolean;
  readonly ackStallMs?: number;
  readonly backlogPollMs?: number;
}

const IDLE: ViewerFlowStep = { _tag: "Idle" };

export type ViewerFlowBlock = "fps" | "ack" | "socket";

/** What a flow reports about itself, for the stream telemetry. Timings only. */
export interface ViewerFlowObserver {
  /** A frame arrived; `replaced` when it overwrote an unsent one. */
  readonly offered: (replaced: boolean) => void;
  /** A frame was written; `queuedMs` is how long it waited since it arrived. */
  readonly sent: (info: {
    readonly bytes: number;
    readonly offeredAt: number;
    readonly sentAt: number;
    readonly queuedMs: number;
    /** How long after the frame-rate slot was open (and the frame there) it was written; wake-up lateness. */
    readonly lateMs: number;
  }) => void;
  /** A frame that was sent had to wait for this (reported once per frame and reason). */
  readonly blocked: (reason: ViewerFlowBlock) => void;
  /** The phone's acknowledgement for the oldest frame still owed arrived `ms` after it was sent. */
  readonly ackRtt: (ms: number) => void;
  /** Unacknowledged frames were presumed lost after the silence limit. */
  readonly ackStalled: () => void;
}

/** Sent-frame times kept to pair acknowledgements with; a client that never acks cannot grow it. */
const MAX_SENT_TIMES = 16;

export class ViewerFlow {
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly backlogLimitBytes: number;
  private readonly maxUnacked: number;
  private readonly adaptiveWindow: boolean;
  private rttBase = Number.POSITIVE_INFINITY;
  private rttRecent: number | null = null;
  private rttSamples = 0;
  private readonly ackStallMs: number;
  private readonly backlogPollMs: number;
  private readonly listeners = new Set<() => void>();
  private backlogProbe: () => number = () => 0;
  private pending: Uint8Array | null = null;
  private pendingRelease: (() => void) | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastActivityAt = 0;
  private unacked = 0;
  private acksEnabled = false;
  private changes = 0;
  private observer: ViewerFlowObserver | null = null;
  private offeredAt = 0;
  private blockReason: ViewerFlowBlock | null = null;
  private blockedSeen = new Set<ViewerFlowBlock>();
  private readonly sentTimes: number[] = [];
  /** Frames written to the socket. */
  sent = 0;
  /** Frames overwritten by a newer one before they could be sent. */
  replaced = 0;

  constructor(options: ViewerFlowOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.minIntervalMs = 1_000 / (options.maxFps ?? VIEWER_FLOW_LIMITS.maxFps);
    this.backlogLimitBytes = options.backlogLimitBytes ?? VIEWER_FLOW_LIMITS.backlogLimitBytes;
    this.maxUnacked = options.maxUnackedFrames ?? VIEWER_FLOW_LIMITS.maxUnackedFrames;
    this.adaptiveWindow = options.adaptiveWindow ?? false;
    this.ackStallMs = options.ackStallMs ?? VIEWER_FLOW_LIMITS.ackStallMs;
    this.backlogPollMs = options.backlogPollMs ?? VIEWER_FLOW_LIMITS.backlogPollMs;
  }

  /** How many bytes the socket has accepted but not yet handed to the network. */
  setBacklogProbe(probe: () => number): void {
    this.backlogProbe = probe;
  }

  /** Bumps on every change, so a waiter can tell it missed one between polling and waiting. */
  get version(): number {
    return this.changes;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  /**
   * How many frames may be unacknowledged now. Two, or three while the acknowledgements come
   * back within 1.3 x the quickest round trip seen plus 15 ms: with a round trip of 85 ms two
   * frames carry only 23 a second, however high the frame rate cap is, and a third costs no
   * delay when the link is not the bottleneck. A queueing link slows the acknowledgements, the
   * test fails and the window drops back to two.
   */
  get windowSize(): number {
    if (!this.adaptiveWindow || this.rttSamples < 5 || this.rttRecent === null)
      return this.maxUnacked;
    return this.rttRecent <= this.rttBase * 1.3 + 15 ? this.maxUnacked + 1 : this.maxUnacked;
  }

  /** Frames sent that the phone has not acknowledged yet (0 until it sends acknowledgements). */
  get inFlight(): number {
    return this.acksEnabled ? this.unacked : 0;
  }

  setObserver(observer: ViewerFlowObserver | null): void {
    this.observer = observer;
  }

  /**
   * The newest frame wins: an unsent older one is dropped. `release` runs, once, when
   * the frame is no longer this flow's business: it was written, a newer frame took
   * its place (at once, here), or it was dropped. Chrome's ack for the frame waits
   * for it.
   */
  offerFrame(frame: Uint8Array, release?: () => void): void {
    const replaced = this.pending !== null;
    if (replaced) this.replaced += 1;
    const overwritten = this.pendingRelease;
    this.pending = frame;
    this.pendingRelease = release ?? null;
    this.offeredAt = this.now();
    this.observer?.offered(replaced);
    this.changed();
    overwritten?.();
  }

  /** Forgets the unsent frame (the page it showed must not reach the phone now). */
  dropPending(): void {
    if (this.pending === null) return;
    const release = this.pendingRelease;
    this.pending = null;
    this.pendingRelease = null;
    this.changed();
    release?.();
  }

  /** The phone received one frame. The first one shows it paces by acknowledgements. */
  acknowledge(): void {
    this.acksEnabled = true;
    this.unacked = Math.max(0, this.unacked - 1);
    this.lastActivityAt = this.now();
    const sentAt = this.sentTimes.shift();
    if (sentAt !== undefined) {
      const rtt = this.lastActivityAt - sentAt;
      this.rttSamples += 1;
      this.rttBase = Math.min(this.rttBase, rtt);
      this.rttRecent = this.rttRecent === null ? rtt : this.rttRecent * 0.75 + rtt * 0.25;
      this.observer?.ackRtt(rtt);
    }
    this.changed();
  }

  /** The next thing the writer should do: send the pending frame, wait, or sleep until one arrives. */
  poll(): ViewerFlowStep {
    const frame = this.pending;
    if (frame === null) return IDLE;
    const now = this.now();
    const waitMs = this.waitMs(now);
    if (waitMs > 0) {
      const reason = this.blockReason;
      if (reason !== null && !this.blockedSeen.has(reason)) {
        this.blockedSeen.add(reason);
        this.observer?.blocked(reason);
      }
      return { _tag: "Wait", ms: waitMs };
    }
    const release = this.pendingRelease;
    const earliest = Math.max(this.offeredAt, this.lastSentAt + this.minIntervalMs);
    this.pending = null;
    this.pendingRelease = null;
    this.lastSentAt = now;
    this.lastActivityAt = now;
    this.unacked += 1;
    this.sent += 1;
    this.blockedSeen.clear();
    this.sentTimes.push(now);
    if (this.sentTimes.length > MAX_SENT_TIMES) this.sentTimes.shift();
    this.observer?.sent({
      bytes: frame.length,
      offeredAt: this.offeredAt,
      sentAt: now,
      queuedMs: now - this.offeredAt,
      lateMs: Math.max(0, now - earliest),
    });
    this.changed();
    release?.();
    return { _tag: "Send", frame };
  }

  /** Runs on every change (a frame offered or sent, an acknowledgement). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private waitMs(now: number): number {
    this.blockReason = null;
    const untilNextSlot = this.lastSentAt + this.minIntervalMs - now;
    if (untilNextSlot > 0) {
      this.blockReason = "fps";
      return Math.ceil(untilNextSlot);
    }
    if (this.acksEnabled && this.unacked >= this.windowSize) {
      const silentFor = now - this.lastActivityAt;
      if (silentFor >= this.ackStallMs) {
        this.unacked = 0;
        this.sentTimes.length = 0;
        this.observer?.ackStalled();
      } else {
        this.blockReason = "ack";
        return Math.ceil(this.ackStallMs - silentFor);
      }
    }
    if (this.backlogProbe() > this.backlogLimitBytes) {
      this.blockReason = "socket";
      return this.backlogPollMs;
    }
    return 0;
  }

  private changed(): void {
    this.changes += 1;
    // A copy: a listener that resumes the writer re-subscribes while we iterate, and
    // Set iteration would visit that new entry in this same pass, forever.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...this.listeners]) listener();
  }
}

/** Resolves on the next change to `flow`, or at once if it changed since `version`. */
const untilChange = (flow: ViewerFlow, version: number) =>
  Effect.callback<void>((resume) => {
    if (flow.version !== version) return resume(Effect.void);
    const unsubscribe = flow.subscribe(() => resume(Effect.void));
    return Effect.sync(unsubscribe);
  });

/** Sends `flow`'s frames through `write` for as long as it runs. Interrupt it to stop. */
export const runViewerFrames = <E, R>(
  flow: ViewerFlow,
  write: (frame: Uint8Array) => Effect.Effect<void, E, R>,
): Effect.Effect<never, E, R> =>
  Effect.gen(function* () {
    while (true) {
      const version = flow.version;
      const step = flow.poll();
      if (step._tag === "Send") {
        yield* write(step.frame);
        continue;
      }
      const change = untilChange(flow, version);
      yield* step._tag === "Wait" ? Effect.raceFirst(change, Effect.sleep(step.ms)) : change;
    }
  });

/**
 * Settles once some flow has no unsent frame left (it sent it, or its viewer
 * left), or after `capMs`. Chrome's frame ack waits for this.
 */
export const untilAnyFlowTookFrame = (flows: ReadonlyArray<ViewerFlow>, capMs: number) => {
  const tookFrame = flows.some((flow) => !flow.hasPending);
  if (tookFrame) return Effect.void;
  const taken = Effect.callback<void>((resume) => {
    const unsubscribe: Array<() => void> = [];
    const check = () => {
      if (flows.some((flow) => !flow.hasPending)) resume(Effect.void);
    };
    for (const flow of flows) unsubscribe.push(flow.subscribe(check));
    return Effect.sync(() => {
      for (const stop of unsubscribe) stop();
    });
  });
  return Effect.raceFirst(taken, Effect.sleep(capMs));
};

/**
 * Hands one Chrome frame to every viewer's flow. `onReleased` runs once, as soon as
 * any of them is done with it (written to a socket, overwritten by a newer frame or
 * dropped), which is when Chrome's ack for it may go. Releasing a frame the moment
 * it is overwritten matters: Chrome keeps at most two frames unacknowledged, so
 * holding the ack of every frame until the next one is written (what 1.60.35 did)
 * left Chrome idle between our writes and sent about half of what it rendered.
 */
export const offerFrameToFlows = (
  flows: ReadonlyArray<ViewerFlow>,
  frame: Uint8Array,
  onReleased: () => void,
): void => {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    onReleased();
  };
  for (const flow of flows) flow.offerFrame(frame, release);
};
