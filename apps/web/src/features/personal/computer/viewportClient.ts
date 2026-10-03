import {
  decodePersonalBrowserFrame,
  personalBrowserInputMovesFocus,
  PersonalBrowserInputMessage,
  PersonalBrowserViewerMessage,
  type PersonalBrowserFrameMeta,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { perfOptimizationOn } from "../perfFlags";
import { createFocusReplyGuard } from "./focusReplyGuard";
import { createPhoneMeter } from "./streamPhoneMeter";

/** How often the phone reports what it measured, once the server asks. */
const STREAM_STATS_INTERVAL_MS = 5_000;

const encodeInput = Schema.encodeSync(Schema.fromJsonString(PersonalBrowserInputMessage));
const FRAME_ACK = encodeInput({ _tag: "FrameAck" });
const decodeViewerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersonalBrowserViewerMessage),
);

export interface ViewportClientCallbacks {
  readonly onOpen: () => void;
  readonly onFrame: (bitmap: ImageBitmap, meta: PersonalBrowserFrameMeta) => void;
  readonly onRejected: (reason: string) => void;
  /** Frames are withheld (a saved password is on screen); the next frame ends it. */
  readonly onHidden: (reason: string) => void;
  /**
   * Whether the last tap left a typable element focused on the remote page,
   * and which kind (older servers never say).
   */
  readonly onFocusChanged: (editable: boolean, field: RemoteField | undefined) => void;
  /** `opened=false` means the upgrade was refused (usually an expired ticket). */
  readonly onClosed: (opened: boolean) => void;
}

export type RemoteField = NonNullable<
  Extract<PersonalBrowserViewerMessage, { readonly _tag: "FocusChanged" }>["field"]
>;

export interface ViewportClient {
  readonly send: (message: PersonalBrowserInputMessage) => void;
  readonly close: () => void;
}

/**
 * One viewport socket. Frames decode off the main thread via
 * `createImageBitmap`; while one decodes, newer frames replace the queued one,
 * so a slow phone shows the latest frame instead of building a backlog.
 */
export function connectViewport(url: string, callbacks: ViewportClientCallbacks): ViewportClient {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let opened = false;
  let closed = false;
  let decoding = false;
  // Set once the server asks for them; an older server would reject the message.
  let acknowledgeFrames = false;
  const focusGuard = createFocusReplyGuard();
  const meter = createPhoneMeter();
  let statsTimer: ReturnType<typeof setInterval> | undefined;
  let queued: {
    readonly jpeg: Uint8Array;
    readonly meta: PersonalBrowserFrameMeta;
    readonly receivedAt: number;
  } | null = null;

  const stopStats = () => {
    if (statsTimer !== undefined) clearInterval(statsTimer);
    statsTimer = undefined;
  };

  const pump = () => {
    const next = queued;
    if (next === null || closed) return;
    queued = null;
    decoding = true;
    const decodeStartedAt = performance.now();
    createImageBitmap(new Blob([next.jpeg.slice()], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (closed) {
          bitmap.close();
          return;
        }
        const decodedAt = performance.now();
        callbacks.onFrame(bitmap, next.meta);
        meter.framePainted({
          receivedAt: next.receivedAt,
          decodeStartedAt,
          decodedAt,
          paintedAt: performance.now(),
        });
      })
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        pump();
      });
  };

  socket.addEventListener("open", () => {
    opened = true;
    callbacks.onOpen();
  });
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") {
      const message = decodeViewerMessage(event.data);
      if (Option.isNone(message)) return;
      switch (message.value._tag) {
        case "FrameAcks":
          acknowledgeFrames = true;
          return;
        case "StreamStatsWanted":
          // Timings only, every few seconds; off with bots:perf-off=stream-telemetry.
          if (statsTimer === undefined && perfOptimizationOn("stream-telemetry")) {
            statsTimer = setInterval(() => {
              const stats = meter.snapshot();
              if (stats !== null && socket.readyState === WebSocket.OPEN) {
                socket.send(encodeInput(stats));
              }
            }, STREAM_STATS_INTERVAL_MS);
          }
          return;
        case "FramesHidden":
          callbacks.onHidden(message.value.reason);
          return;
        case "FocusChanged":
          // A reply to an earlier tap must not undo what a newer tap did.
          if (focusGuard.accept(message.value.seq)) {
            callbacks.onFocusChanged(message.value.editable, message.value.field);
          }
          return;
        default:
          callbacks.onRejected(message.value.reason);
          return;
      }
    }
    if (!(event.data instanceof ArrayBuffer)) return;
    // On receipt, before decoding: it tells the server the link delivered the
    // frame, so it can send the next without a backlog building up on the way.
    if (acknowledgeFrames && socket.readyState === WebSocket.OPEN) socket.send(FRAME_ACK);
    const receivedAt = meter.frameReceived();
    const frame = decodePersonalBrowserFrame(new Uint8Array(event.data));
    if (frame === null) return;
    if (queued !== null) meter.frameReplaced();
    queued = { ...frame, receivedAt };
    if (!decoding) pump();
  });
  socket.addEventListener("close", () => {
    stopStats();
    if (closed) return;
    closed = true;
    callbacks.onClosed(opened);
  });

  return {
    send: (message) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (message._tag === "Wheel") meter.inputSent("wheel");
      else if (message._tag === "Pointer" && message.action === "tap") meter.inputSent("tap");
      // The server echoes the number on the focus report that answers this input.
      socket.send(
        encodeInput(
          personalBrowserInputMovesFocus(message)
            ? ({ ...message, seq: focusGuard.issue() } as PersonalBrowserInputMessage)
            : message,
        ),
      );
    },
    close: () => {
      closed = true;
      stopStats();
      socket.close();
    },
  };
}
