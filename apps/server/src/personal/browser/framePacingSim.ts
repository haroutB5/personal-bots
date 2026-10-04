/**
 * A virtual-time model of the live view's frame path, for tests: Chrome's screencast,
 * the real `ViewerFlow`, and a link with a rate and a round trip. Chrome renders a
 * frame when the page changes (a scroll step every `changeEveryMs`), at most one per
 * `minEmitGapMs`, and never has more than two frames unacknowledged: a change that
 * finds two out is dropped and is not rendered later, which is how the real
 * screencast behaves and why holding acks costs frames. Chrome's ack is wired as `PersonalBrowser` wires it: the
 * early release of 1.60.36 through `offerFrameToFlows`, or the holding of 1.60.35
 * (`mode: "held"`, the kill switch's path) where every frame's ack waits until the
 * flow has no pending frame.
 *
 * Time moves in whole milliseconds, so rates are exact to about a frame.
 */
import { offerFrameToFlows, ViewerFlow } from "./viewerFlow.ts";

export interface FrameSimOptions {
  readonly mode: "early" | "held";
  /** The page changes this often while it scrolls (a scroll step lands), in ms. */
  readonly changeEveryMs: number;
  /** Chrome renders at most one frame in this many ms. */
  readonly minEmitGapMs?: number;
  /** The page changes (scrolls) for this long, then stands still. */
  readonly contentMs: number;
  /** Total time simulated. */
  readonly durationMs: number;
  readonly maxFps: number;
  readonly maxUnackedFrames?: number;
  readonly adaptiveWindow?: boolean;
  readonly frameBytes: number;
  /** Link rate in bytes per second; 0 is unlimited. */
  readonly linkBytesPerSecond: number;
  /** Round trip of the link, split evenly. */
  readonly rttMs: number;
}

export interface FrameSimResult {
  readonly chromeFrames: number;
  readonly sent: number;
  readonly replaced: number;
  /** Frames sent per second while the page was changing. */
  readonly sentPerSecond: number;
  readonly chromeFramesPerSecond: number;
  /** Longest gap between two sends while the page was changing, in ms. */
  readonly maxSendGapMs: number;
  /** Most frames the phone owed an acknowledgement for at once. */
  readonly maxUnacked: number;
  /** Page changes Chrome did not render because it already had two frames out. */
  readonly droppedChanges: number;
  /** Whether the page's last change reached the phone: its frame was rendered and is the last one written. */
  readonly finalStateSent: boolean;
  /** Frames Chrome had unacknowledged at most. */
  readonly maxChromeInFlight: number;
  /** Longest a frame waited from arriving to being sent, in ms. */
  readonly maxQueuedMs: number;
  /** How long after Chrome rendered its last frame that frame was written. Null if it never was. */
  readonly lastFrameDelayMs: number | null;
  /** Whether the last frame Chrome rendered is the last one written. */
  readonly lastFrameWasSent: boolean;
}

export function simulateFramePath(options: FrameSimOptions): FrameSimResult {
  let now = 0;
  const flow = new ViewerFlow({
    now: () => now,
    maxFps: options.maxFps,
    ...(options.maxUnackedFrames === undefined
      ? {}
      : { maxUnackedFrames: options.maxUnackedFrames }),
    ...(options.adaptiveWindow === undefined ? {} : { adaptiveWindow: options.adaptiveWindow }),
  });
  flow.acknowledge(); // the phone has shown it acknowledges: the window is on
  let queuedMax = 0;
  flow.setObserver({
    offered: () => {},
    sent: (info) => {
      queuedMax = Math.max(queuedMax, info.queuedMs);
    },
    blocked: () => {},
    ackRtt: () => {},
    ackStalled: () => {},
  });

  const oneWay = options.rttMs / 2;
  const events: Array<{ at: number; run: () => void }> = [];
  let linkFreeAt = 0;
  let chromeInFlight = 0;
  let maxChromeInFlight = 0;
  let lastEmitAt = -Infinity;
  let emitted = 0;
  let dropped = 0;
  let lastChangeAt = -1;
  let lastChangeEmitted = false;
  const held: Array<() => void> = [];
  const sendTimes: number[] = [];
  let sentFrameId = -1;
  let lastEmittedId = -1;
  let lastEmitTime = 0;
  let lastSentTime = 0;
  let maxUnacked = 0;
  const frameIds = new WeakMap<Uint8Array, number>();

  const releaseFrame = () => {
    chromeInFlight -= 1;
  };

  for (now = 0; now < options.durationMs; now += 1) {
    // Acknowledgements that reached the server.
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i]!.at <= now) {
        const [due] = events.splice(i, 1);
        due!.run();
      }
    }
    // The 1.60.35 holding: a held frame's ack goes when the flow has no pending frame.
    if (options.mode === "held" && !flow.hasPending) {
      for (const release of held.splice(0)) release();
    }
    // The page changes; Chrome renders a frame for the change if it has fewer than two out.
    const changes = now < options.contentMs && now % options.changeEveryMs === 0;
    if (changes) lastChangeAt = now;
    if (changes && (chromeInFlight >= 2 || now - lastEmitAt < (options.minEmitGapMs ?? 16))) {
      dropped += 1;
      lastChangeEmitted = false;
    } else if (changes) {
      lastChangeEmitted = true;
      lastEmitAt = now;
      emitted += 1;
      chromeInFlight += 1;
      maxChromeInFlight = Math.max(maxChromeInFlight, chromeInFlight);
      const frame = new Uint8Array(options.frameBytes);
      lastEmittedId = emitted;
      lastEmitTime = now;
      frameIds.set(frame, emitted);
      if (options.mode === "early") {
        offerFrameToFlows([flow], frame, releaseFrame);
      } else {
        flow.offerFrame(frame);
        held.push(releaseFrame);
      }
    }
    // The writer: whatever the flow lets go out now.
    for (let step = flow.poll(); step._tag === "Send"; step = flow.poll()) {
      sendTimes.push(now);
      sentFrameId = frameIds.get(step.frame) ?? -1;
      lastSentTime = now;
      const start = Math.max(linkFreeAt, now);
      const transmit =
        options.linkBytesPerSecond > 0
          ? (step.frame.length / options.linkBytesPerSecond) * 1_000
          : 0;
      linkFreeAt = start + transmit;
      const arrives = linkFreeAt + oneWay;
      events.push({ at: Math.ceil(arrives + oneWay), run: () => flow.acknowledge() });
      maxUnacked = Math.max(maxUnacked, flow.inFlight);
    }
  }

  const changing = sendTimes.filter((at) => at < options.contentMs);
  let maxGap = 0;
  for (let i = 1; i < changing.length; i += 1)
    maxGap = Math.max(maxGap, changing[i]! - changing[i - 1]!);
  const seconds = options.contentMs / 1_000;
  return {
    chromeFrames: emitted,
    sent: sendTimes.length,
    replaced: flow.replaced,
    sentPerSecond: changing.length / seconds,
    chromeFramesPerSecond: emitted / seconds,
    maxSendGapMs: maxGap,
    maxUnacked,
    maxChromeInFlight,
    maxQueuedMs: queuedMax,
    lastFrameDelayMs: sentFrameId === lastEmittedId ? lastSentTime - lastEmitTime : null,
    lastFrameWasSent: sentFrameId === lastEmittedId,
    droppedChanges: dropped,
    finalStateSent: lastChangeAt >= 0 && lastChangeEmitted && sentFrameId === lastEmittedId,
  };
}
