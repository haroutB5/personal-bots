import {
  decodePersonalBrowserFrame,
  PersonalDesktopViewInput,
  PersonalDesktopViewMessage,
  type PersonalDesktopViewState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const encodeInput = Schema.encodeSync(Schema.fromJsonString(PersonalDesktopViewInput));
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalDesktopViewMessage));

export interface DesktopViewCallbacks {
  readonly onOpen: () => void;
  /** A decoded frame; the client acknowledges it once this returns. */
  readonly onFrame: (bitmap: ImageBitmap, size: { width: number; height: number }) => void;
  readonly onState: (state: PersonalDesktopViewState, detail: string | null) => void;
  /** `opened=false` means the upgrade was refused (usually an expired ticket). */
  readonly onClosed: (opened: boolean) => void;
  /** Whether this socket controls the PC, and why not when the server ended it. */
  readonly onControl?: (on: boolean, detail: string | null) => void;
  /** One input was refused; nothing was done on the PC. */
  readonly onInputRefused?: (detail: string) => void;
}

export interface DesktopViewClient {
  /** The box frames are shown in, in device pixels. */
  readonly setViewport: (width: number, height: number) => void;
  /** Control and input messages; dropped while the socket is not open. */
  readonly send: (message: PersonalDesktopViewInput) => void;
  readonly close: () => void;
}

/** The pieces of the browser this client uses, so tests can hand in fakes. */
export interface DesktopViewEnvironment {
  readonly createSocket: (url: string) => WebSocket;
  readonly decodeImage: (jpeg: Uint8Array) => Promise<ImageBitmap>;
}

const browserEnvironment: DesktopViewEnvironment = {
  createSocket: (url) => new WebSocket(url),
  decodeImage: (jpeg) => createImageBitmap(new Blob([jpeg.slice()], { type: "image/jpeg" })),
};

/**
 * One live view socket. The server sends a frame only after the previous one
 * was acknowledged, and this client acknowledges only after drawing it, so a
 * slow phone or relay slows the stream down instead of queueing frames. A
 * frame that fails to decode is still acknowledged, or the stream would stall
 * until the server's ack timeout.
 */
export function connectDesktopView(
  url: string,
  callbacks: DesktopViewCallbacks,
  environment: DesktopViewEnvironment = browserEnvironment,
): DesktopViewClient {
  const socket = environment.createSocket(url);
  socket.binaryType = "arraybuffer";
  let opened = false;
  let closed = false;
  let pendingViewport: { width: number; height: number } | null = null;

  const send = (message: PersonalDesktopViewInput) => {
    if (!closed && socket.readyState === WebSocket.OPEN) socket.send(encodeInput(message));
  };

  socket.addEventListener("open", () => {
    opened = true;
    if (pendingViewport !== null) send({ _tag: "Viewport", ...pendingViewport });
    callbacks.onOpen();
  });
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") {
      const decoded = decodeMessage(event.data);
      if (Option.isNone(decoded)) return;
      const message = decoded.value;
      switch (message._tag) {
        case "ViewState":
          callbacks.onState(message.state, message.detail ?? null);
          return;
        case "Control":
          callbacks.onControl?.(message.on, message.detail ?? null);
          return;
        case "InputRefused":
          callbacks.onInputRefused?.(message.detail);
          return;
      }
      return;
    }
    if (!(event.data instanceof ArrayBuffer)) return;
    const frame = decodePersonalBrowserFrame(new Uint8Array(event.data));
    if (frame === null) {
      send({ _tag: "Ack" });
      return;
    }
    environment
      .decodeImage(frame.jpeg)
      .then((bitmap) => {
        if (closed) bitmap.close();
        else callbacks.onFrame(bitmap, { width: frame.meta.width, height: frame.meta.height });
      })
      .catch(() => undefined)
      .finally(() => send({ _tag: "Ack" }));
  });
  socket.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    callbacks.onClosed(opened);
  });

  return {
    setViewport: (width, height) => {
      const box = {
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      };
      pendingViewport = box;
      send({ _tag: "Viewport", ...box });
    },
    send,
    close: () => {
      closed = true;
      socket.close();
    },
  };
}
