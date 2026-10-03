/**
 * What the phone measures about the shared-browser live view, to be sent to the
 * server every few seconds so its log shows both ends of the stream: frames
 * received, the longest gap between them, decode and paint times, and how long
 * a tap or a scroll took to show up on screen. Timings and counts only: no
 * page content, coordinates or text. Switched off with
 * `bots:perf-off = stream-telemetry` or when the server does not ask.
 */
import type { PersonalBrowserInputMessage } from "@t3tools/contracts";

export type StreamStatsMessage = Extract<
  PersonalBrowserInputMessage,
  { readonly _tag: "StreamStats" }
>;

type Pair = { readonly p50: number; readonly p95: number };

/** Samples kept per series in one window. */
const MAX_SAMPLES = 512;
/** Inputs waiting for a frame that can show their effect. */
const MAX_PENDING = 32;

const pair = (values: ReadonlyArray<number>): Pair | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]! * 10) /
    10;
  return { p50: at(0.5), p95: at(0.95) };
};

const push = (values: number[], value: number) => {
  if (values.length < MAX_SAMPLES) values.push(value);
};

export interface PhoneMeter {
  /** A frame arrived on the socket. Returns its arrival time. */
  readonly frameReceived: () => number;
  /** A frame was dropped on the phone for a newer one before it was decoded. */
  readonly frameReplaced: () => void;
  /** A frame was decoded and drawn. */
  readonly framePainted: (times: {
    readonly receivedAt: number;
    readonly decodeStartedAt: number;
    readonly decodedAt: number;
    readonly paintedAt: number;
  }) => void;
  /** A tap or a scroll step was sent. */
  readonly inputSent: (kind: "tap" | "wheel") => void;
  /** The window's numbers, then a fresh window. Null when nothing happened. */
  readonly snapshot: () => StreamStatsMessage | null;
}

export function createPhoneMeter(now: () => number = () => performance.now()): PhoneMeter {
  let windowStartedAt = now();
  let frames = 0;
  let replaced = 0;
  let taps = 0;
  let wheels = 0;
  let maxGapMs = 0;
  let lastReceivedAt: number | null = null;
  let decode: number[] = [];
  let paint: number[] = [];
  let receiveToPaint: number[] = [];
  let tapToPaint: number[] = [];
  let wheelToPaint: number[] = [];
  let pendingTaps: number[] = [];
  let pendingWheels: number[] = [];

  /** The oldest input whose effect this frame (received at `receivedAt`) can show. */
  const resolve = (pending: number[], receivedAt: number, paintedAt: number, into: number[]) => {
    const shown = pending.filter((sentAt) => sentAt <= receivedAt);
    if (shown.length === 0) return pending;
    push(into, paintedAt - shown[0]!);
    return pending.filter((sentAt) => sentAt > receivedAt);
  };

  return {
    frameReceived: () => {
      const at = now();
      frames += 1;
      if (lastReceivedAt !== null) maxGapMs = Math.max(maxGapMs, at - lastReceivedAt);
      lastReceivedAt = at;
      return at;
    },
    frameReplaced: () => {
      replaced += 1;
    },
    framePainted: ({ receivedAt, decodeStartedAt, decodedAt, paintedAt }) => {
      push(decode, decodedAt - decodeStartedAt);
      push(paint, paintedAt - decodedAt);
      push(receiveToPaint, paintedAt - receivedAt);
      pendingTaps = resolve(pendingTaps, receivedAt, paintedAt, tapToPaint);
      pendingWheels = resolve(pendingWheels, receivedAt, paintedAt, wheelToPaint);
    },
    inputSent: (kind) => {
      const at = now();
      if (kind === "tap") {
        taps += 1;
        pendingTaps.push(at);
        if (pendingTaps.length > MAX_PENDING) pendingTaps.shift();
      } else {
        wheels += 1;
        pendingWheels.push(at);
        if (pendingWheels.length > MAX_PENDING) pendingWheels.shift();
      }
    },
    snapshot: () => {
      const at = now();
      const empty = frames === 0 && taps === 0 && wheels === 0;
      const snapshot: StreamStatsMessage = {
        _tag: "StreamStats",
        windowMs: Math.round(at - windowStartedAt),
        frames,
        replaced,
        maxGapMs: Math.round(maxGapMs),
        taps,
        wheels,
        ...(pair(decode) === undefined ? {} : { decode: pair(decode)! }),
        ...(pair(paint) === undefined ? {} : { paint: pair(paint)! }),
        ...(pair(receiveToPaint) === undefined ? {} : { receiveToPaint: pair(receiveToPaint)! }),
        ...(pair(tapToPaint) === undefined ? {} : { tapToPaint: pair(tapToPaint)! }),
        ...(pair(wheelToPaint) === undefined ? {} : { wheelToPaint: pair(wheelToPaint)! }),
      };
      windowStartedAt = at;
      frames = 0;
      replaced = 0;
      taps = 0;
      wheels = 0;
      maxGapMs = 0;
      lastReceivedAt = null;
      decode = [];
      paint = [];
      receiveToPaint = [];
      tapToPaint = [];
      wheelToPaint = [];
      return empty ? null : snapshot;
    },
  };
}
