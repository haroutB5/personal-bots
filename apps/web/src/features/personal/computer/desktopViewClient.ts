import {
  decodePersonalBrowserFrame,
  decodePersonalDesktopFrame,
  PersonalDesktopViewInput,
  PersonalDesktopViewMessage,
  type PersonalDesktopViewRegion,
  type PersonalDesktopViewState,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const encodeInput = Schema.encodeSync(Schema.fromJsonString(PersonalDesktopViewInput));
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(PersonalDesktopViewMessage));

/** What one frame is. A server without region frames sends only the size. */
export interface DesktopFrameInfo {
  readonly width: number;
  readonly height: number;
  /** The part of the monitor it shows, in monitor pixels. */
  readonly region?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** The monitor's size in its own pixels. */
  readonly screen?: { readonly width: number; readonly height: number };
}

export interface DesktopViewCallbacks {
  readonly onOpen: () => void;
  /** A decoded frame; the client acknowledges it once this returns. */
  readonly onFrame: (bitmap: ImageBitmap, frame: DesktopFrameInfo) => void;
  readonly onState: (state: PersonalDesktopViewState, detail: string | null) => void;
  /** `opened=false` means the upgrade was refused (usually an expired ticket). */
  readonly onClosed: (opened: boolean) => void;
  /** Whether this socket controls the PC, and why not when the server ended it. */
  readonly onControl?: (on: boolean, detail: string | null) => void;
  /** One input was refused; nothing was done on the PC. */
  readonly onInputRefused?: (detail: string) => void;
}

export interface DesktopViewClient {
  /**
   * The box frames are shown in, in device pixels, and the part of the
   * monitor shown there (fractions; the whole monitor unless zoomed in).
   */
  readonly setViewport: (width: number, height: number, region?: PersonalDesktopViewRegion) => void;
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
  let pendingViewport: {
    width: number;
    height: number;
    region?: PersonalDesktopViewRegion;
  } | null = null;

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
    const bytes = new Uint8Array(event.data);
    const regionFrame = decodePersonalDesktopFrame(bytes);
    const plainFrame = regionFrame === null ? decodePersonalBrowserFrame(bytes) : null;
    const jpeg = regionFrame?.jpeg ?? plainFrame?.jpeg;
    if (jpeg === undefined) {
      send({ _tag: "Ack" });
      return;
    }
    const info: DesktopFrameInfo =
      regionFrame !== null
        ? {
            width: regionFrame.meta.width,
            height: regionFrame.meta.height,
            region: regionFrame.meta.region,
            screen: {
              width: regionFrame.meta.screenWidth,
              height: regionFrame.meta.screenHeight,
            },
          }
        : { width: plainFrame!.meta.width, height: plainFrame!.meta.height };
    environment
      .decodeImage(jpeg)
      .then((bitmap) => {
        if (closed) bitmap.close();
        else callbacks.onFrame(bitmap, info);
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
    setViewport: (width, height, region) => {
      const box = {
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
        ...(region === undefined ? {} : { region }),
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
