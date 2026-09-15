import {
  decodePersonalBrowserFrame,
  PersonalBrowserInputMessage,
  PersonalBrowserViewerMessage,
  type PersonalBrowserFrameMeta,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const encodeInput = Schema.encodeSync(Schema.fromJsonString(PersonalBrowserInputMessage));
const decodeViewerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersonalBrowserViewerMessage),
);

export interface ViewportClientCallbacks {
  readonly onOpen: () => void;
  readonly onFrame: (bitmap: ImageBitmap, meta: PersonalBrowserFrameMeta) => void;
  readonly onRejected: (reason: string) => void;
  /** Frames are withheld (a saved password is on screen); the next frame ends it. */
  readonly onHidden: (reason: string) => void;
  /** `opened=false` means the upgrade was refused (usually an expired ticket). */
  readonly onClosed: (opened: boolean) => void;
}

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
  let queued: { readonly jpeg: Uint8Array; readonly meta: PersonalBrowserFrameMeta } | null = null;

  const pump = () => {
    const next = queued;
    if (next === null || closed) return;
    queued = null;
    decoding = true;
    createImageBitmap(new Blob([next.jpeg.slice()], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (closed) bitmap.close();
        else callbacks.onFrame(bitmap, next.meta);
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
      if (message.value._tag === "FramesHidden") callbacks.onHidden(message.value.reason);
      else callbacks.onRejected(message.value.reason);
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = decodePersonalBrowserFrame(new Uint8Array(event.data));
    if (frame === null) return;
    queued = frame;
    if (!decoding) pump();
  });
  socket.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    callbacks.onClosed(opened);
  });

  return {
    send: (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(encodeInput(message));
    },
    close: () => {
      closed = true;
      socket.close();
    },
  };
}
