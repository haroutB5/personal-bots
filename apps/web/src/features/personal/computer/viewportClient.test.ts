import { encodePersonalBrowserFrame } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { connectViewport } from "./viewportClient";

type Listener = (event: { readonly data: unknown }) => void;

/** Just enough of a WebSocket to deliver server text messages to the client. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readonly readyState = 1;
  binaryType = "blob";
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  receive(data: unknown) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {}
}

const connect = () => {
  const calls = { rejected: [] as string[], hidden: [] as string[], focus: [] as boolean[] };
  vi.stubGlobal("WebSocket", FakeSocket);
  const client = connectViewport("ws://laptop/stream", {
    onOpen: () => {},
    onFrame: () => {},
    onRejected: (reason) => calls.rejected.push(reason),
    onHidden: (reason) => calls.hidden.push(reason),
    onFocusChanged: (editable) => calls.focus.push(editable),
    onClosed: () => {},
  });
  return { calls, client, socket: FakeSocket.last! };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("viewport client messages", () => {
  // A withheld-frames notice is not an input rejection: the screen clears it
  // on the next frame, while a rejection stays until the socket reopens.
  it("routes a hidden-frames notice apart from an input rejection", () => {
    const { calls, socket } = connect();

    socket.receive('{"_tag":"FramesHidden","reason":"Hidden while a saved password is filled."}');
    socket.receive('{"_tag":"InputRejected","reason":"Take control before interacting."}');
    socket.receive('{"_tag":"SomethingNewer","reason":"ignored"}');

    expect(calls.hidden).toEqual(["Hidden while a saved password is filled."]);
    expect(calls.rejected).toEqual(["Take control before interacting."]);
  });

  // Post-tap focus reports drive the phone's own keyboard and must never be
  // mistaken for a rejection, which would paint a notice over the frame.
  it("routes post-tap focus reports apart from rejections", () => {
    const { calls, socket } = connect();

    socket.receive('{"_tag":"FocusChanged","editable":true}');
    socket.receive('{"_tag":"FocusChanged","editable":false}');

    expect(calls.focus).toEqual([true, false]);
    expect(calls.rejected).toEqual([]);
    expect(calls.hidden).toEqual([]);
  });

  // The server paces frames by these replies, but only once it has asked for
  // them: a server from before this release would answer one with an input
  // rejection for every frame.
  // A tap on a button is answered "no field" a beat later. If the next tap lands
  // on a text field first, that late answer must not put the keyboard down.
  describe("focus reports and taps", () => {
    const tapAt = (x: number) => ({ _tag: "Pointer", action: "tap", x, y: 10 }) as const;

    it("numbers each tap, and Tab or Enter, but not other input", () => {
      const { client, socket } = connect();

      client.send(tapAt(1));
      client.send({ _tag: "Key", key: "Tab" });
      client.send({ _tag: "Key", key: "a" });
      client.send({ _tag: "Wheel", x: 1, y: 1, deltaX: 0, deltaY: 5 });
      client.send(tapAt(2));

      expect(socket.sent.map((text) => JSON.parse(text).seq)).toEqual([
        1,
        2,
        undefined,
        undefined,
        3,
      ]);
    });

    it("ignores the late answer to a button tap once a field was tapped", () => {
      const { calls, client, socket } = connect();

      client.send(tapAt(1));
      client.send(tapAt(2));
      socket.receive('{"_tag":"FocusChanged","editable":false,"seq":1}');
      expect(calls.focus).toEqual([]);

      socket.receive('{"_tag":"FocusChanged","editable":true,"field":"text","seq":2}');
      expect(calls.focus).toEqual([true]);
      // Even a straggler that arrives after the newer answer.
      socket.receive('{"_tag":"FocusChanged","editable":false,"seq":1}');
      expect(calls.focus).toEqual([true]);
    });

    it("acts on an answer when nothing newer was sent, and on one with no number", () => {
      const { calls, client, socket } = connect();

      client.send(tapAt(1));
      socket.receive('{"_tag":"FocusChanged","editable":false,"seq":1}');
      client.send(tapAt(2));
      socket.receive('{"_tag":"FocusChanged","editable":false}');

      expect(calls.focus).toEqual([false, false]);
    });
  });

  describe("stream stats", () => {
    const frame = () =>
      encodePersonalBrowserFrame(new Uint8Array([1, 2, 3]), {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
      }).buffer;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports timings every few seconds once the server asks, and not before", () => {
      vi.useFakeTimers();
      vi.stubGlobal("createImageBitmap", () => new Promise(() => {}));
      const { client, socket } = connect();

      socket.receive(frame());
      vi.advanceTimersByTime(6_000);
      expect(socket.sent).toEqual([]);

      socket.receive('{"_tag":"StreamStatsWanted"}');
      socket.receive(frame());
      client.send({ _tag: "Pointer", action: "tap", x: 5, y: 5 });
      vi.advanceTimersByTime(5_000);
      const reports = socket.sent
        .map((text) => JSON.parse(text))
        .filter((m) => m._tag === "StreamStats");
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ frames: 2, taps: 1, wheels: 0 });
      // Nothing happened in the next window: nothing is sent.
      vi.advanceTimersByTime(5_000);
      expect(socket.sent.filter((text) => text.includes("StreamStats"))).toHaveLength(1);
    });

    it("sends nothing with the kill switch on", () => {
      vi.useFakeTimers();
      vi.stubGlobal("createImageBitmap", () => new Promise(() => {}));
      vi.stubGlobal("localStorage", { getItem: () => "stream-telemetry" });
      const { socket } = connect();

      socket.receive('{"_tag":"StreamStatsWanted"}');
      socket.receive(frame());
      vi.advanceTimersByTime(10_000);
      expect(socket.sent.filter((text) => text.includes("StreamStats"))).toEqual([]);
    });
  });

  describe("frame acknowledgements", () => {
    const frame = () =>
      encodePersonalBrowserFrame(new Uint8Array([1, 2, 3]), {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
      }).buffer;

    it("sends one per frame once the server asks, and never before", () => {
      // Decoding is not under test: a bitmap that never arrives is enough.
      vi.stubGlobal("createImageBitmap", () => new Promise(() => {}));
      const { calls, socket } = connect();

      socket.receive(frame());
      expect(socket.sent).toEqual([]);

      socket.receive('{"_tag":"FrameAcks"}');
      socket.receive(frame());
      socket.receive(frame());
      expect(socket.sent).toEqual(['{"_tag":"FrameAck"}', '{"_tag":"FrameAck"}']);
      // The request itself is housekeeping, not an input rejection.
      expect(calls.rejected).toEqual([]);
    });
  });
});
