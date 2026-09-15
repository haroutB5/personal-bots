import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { connectViewport } from "./viewportClient";

type Listener = (event: { readonly data: unknown }) => void;

/** Just enough of a WebSocket to deliver server text messages to the client. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readonly readyState = 1;
  binaryType = "blob";
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
  send() {}
  close() {}
}

const connect = () => {
  const calls = { rejected: [] as string[], hidden: [] as string[] };
  vi.stubGlobal("WebSocket", FakeSocket);
  connectViewport("ws://laptop/stream", {
    onOpen: () => {},
    onFrame: () => {},
    onRejected: (reason) => calls.rejected.push(reason),
    onHidden: (reason) => calls.hidden.push(reason),
    onClosed: () => {},
  });
  return { calls, socket: FakeSocket.last! };
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
});
