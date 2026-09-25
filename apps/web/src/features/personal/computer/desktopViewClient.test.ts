import { encodePersonalBrowserFrame, encodePersonalDesktopFrame } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { connectDesktopView } from "./desktopViewClient";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(name: string, listener: Listener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string, data?: unknown) {
    for (const listener of this.listeners.get(name) ?? []) listener({ data });
  }
  send(text: string) {
    this.sent.push(text);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
}

const frameBytes = (width: number, height: number) => {
  const bytes = encodePersonalBrowserFrame(new Uint8Array([0xff, 0xd8, 1, 2]), {
    width,
    height,
    deviceScaleFactor: 1,
  });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(decode: (jpeg: Uint8Array) => Promise<ImageBitmap>) {
  vi.stubGlobal("WebSocket", { OPEN: 1 });
  const socket = new FakeSocket();
  const callbacks = {
    onOpen: vi.fn(),
    onFrame: vi.fn(),
    onState: vi.fn(),
    onClosed: vi.fn(),
    onControl: vi.fn(),
    onInputRefused: vi.fn(),
  };
  const client = connectDesktopView("wss://pc.example/api/personal/desktop/stream", callbacks, {
    createSocket: () => socket as unknown as WebSocket,
    decodeImage: decode,
  });
  return { socket, callbacks, client };
}

const bitmap = () => ({ width: 640, height: 400, close: vi.fn() }) as unknown as ImageBitmap;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop live view client", () => {
  it("acknowledges a frame only after it was drawn, one at a time", async () => {
    let finishDecode: (value: ImageBitmap) => void = () => undefined;
    const { socket, callbacks } = setup(
      () => new Promise<ImageBitmap>((resolve) => (finishDecode = resolve)),
    );
    socket.open();
    socket.emit("message", frameBytes(640, 400));
    await flush();
    // Still decoding: no ack yet, so the server sends nothing more.
    expect(socket.sent).toEqual([]);
    finishDecode(bitmap());
    await flush();
    expect(callbacks.onFrame).toHaveBeenCalledWith(expect.anything(), { width: 640, height: 400 });
    expect(socket.sent).toEqual([JSON.stringify({ _tag: "Ack" })]);
  });

  it("still acknowledges a frame it could not decode, so the stream never stalls", async () => {
    const { socket, callbacks } = setup(() => Promise.reject(new Error("bad jpeg")));
    socket.open();
    socket.emit("message", frameBytes(640, 400));
    await flush();
    await flush();
    expect(callbacks.onFrame).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([JSON.stringify({ _tag: "Ack" })]);
  });

  it("sends the viewport once open, and again when it changes", () => {
    const { socket, client } = setup(() => Promise.resolve(bitmap()));
    client.setViewport(1170.4, 1170.4);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ _tag: "Viewport", width: 1170, height: 1170 });
    client.setViewport(2532, 1170);
    expect(JSON.parse(socket.sent[1]!)).toEqual({ _tag: "Viewport", width: 2532, height: 1170 });
  });

  it("passes a region frame on with what it shows, and sends the zoomed region", async () => {
    const { socket, callbacks, client } = setup(() => Promise.resolve(bitmap()));
    socket.open();
    const meta = {
      width: 1024,
      height: 640,
      region: { x: 1024, y: 640, width: 1024, height: 640 },
      screenWidth: 3072,
      screenHeight: 1920,
    };
    const bytes = encodePersonalDesktopFrame(new Uint8Array([0xff, 0xd8, 1, 2]), meta);
    socket.emit(
      "message",
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    await flush();
    expect(callbacks.onFrame).toHaveBeenCalledWith(expect.anything(), {
      width: 1024,
      height: 640,
      region: meta.region,
      screen: { width: 3072, height: 1920 },
    });
    expect(socket.sent).toEqual([JSON.stringify({ _tag: "Ack" })]);
    const region = { x: 0.3, y: 0.3, width: 0.4, height: 0.4 };
    client.setViewport(1170, 732, region);
    expect(JSON.parse(socket.sent[1]!)).toEqual({
      _tag: "Viewport",
      width: 1170,
      height: 732,
      region,
    });
  });

  it("passes the view state on (locked, unavailable) and ignores junk", () => {
    const { socket, callbacks } = setup(() => Promise.resolve(bitmap()));
    socket.open();
    socket.emit("message", JSON.stringify({ _tag: "ViewState", state: "locked" }));
    socket.emit(
      "message",
      JSON.stringify({ _tag: "ViewState", state: "unavailable", detail: "No monitor" }),
    );
    socket.emit("message", "{nope");
    expect(callbacks.onState.mock.calls).toEqual([
      ["locked", null],
      ["unavailable", "No monitor"],
    ]);
  });

  it("closing stops everything: no more draws, acks or close callbacks", async () => {
    const { socket, callbacks, client } = setup(() => Promise.resolve(bitmap()));
    socket.open();
    socket.emit("message", frameBytes(640, 400));
    client.close();
    await flush();
    expect(socket.closed).toBe(true);
    expect(callbacks.onFrame).not.toHaveBeenCalled();
    socket.emit("close");
    expect(callbacks.onClosed).not.toHaveBeenCalled();
  });

  it("reports whether a closed socket had opened (a refused upgrade means a stale ticket)", () => {
    const { socket, callbacks } = setup(() => Promise.resolve(bitmap()));
    socket.emit("close");
    expect(callbacks.onClosed).toHaveBeenCalledWith(false);
  });

  it("sends control and input once open, and passes control state and refusals on", () => {
    const { socket, callbacks, client } = setup(() => Promise.resolve(bitmap()));
    client.send({ _tag: "Control", on: true });
    // Not open yet: dropped rather than queued (the pane re-sends on open).
    expect(socket.sent).toEqual([]);
    socket.open();
    client.send({ _tag: "Control", on: true });
    client.send({ _tag: "Keys", keys: "ctrl+c" });
    expect(socket.sent.map((text) => JSON.parse(text)._tag)).toEqual(["Control", "Keys"]);
    socket.emit("message", JSON.stringify({ _tag: "Control", on: true }));
    socket.emit(
      "message",
      JSON.stringify({ _tag: "Control", on: false, detail: "Remote control ended." }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        _tag: "InputRefused",
        detail: "PC is locked; it can't be unlocked remotely.",
      }),
    );
    expect(callbacks.onControl.mock.calls).toEqual([
      [true, null],
      [false, "Remote control ended."],
    ]);
    expect(callbacks.onInputRefused).toHaveBeenCalledWith(
      "PC is locked; it can't be unlocked remotely.",
    );
    expect(callbacks.onState).not.toHaveBeenCalled();
  });
});
