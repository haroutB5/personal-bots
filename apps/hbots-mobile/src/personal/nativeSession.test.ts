import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { classifyFailure } from "../failure";
import type { StoredSession } from "../session";
import { connectNativeSession } from "./nativeSession";

vi.mock("../pairing", () => ({
  openSocketUrl: async () => "wss://hbots.example.test/ws?wsTicket=ticket",
}));

interface SocketEvent {
  readonly code?: number;
  readonly reason?: string;
  readonly data?: string;
}

type Listener = (event: SocketEvent) => void;

class FakeWebSocket {
  static instances: Array<FakeWebSocket> = [];
  readyState = 0;
  readonly sent: Array<string> = [];
  binaryType = "arraybuffer";
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emit(type: string, event: SocketEvent) {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const stored: StoredSession = {
  environmentId: "environment-1",
  label: "Laptop",
  httpBaseUrl: "https://hbots.example.test",
  wsBaseUrl: "wss://hbots.example.test",
  accessToken: "token",
  scope: "orchestration:read",
  expiresAt: 1_800_000_000_000,
  pairedAt: 1_700_000_000_000,
};

const closeWith = async (code: number, reason: string) => {
  const native = await connectNativeSession(stored, "1.67.6", () => undefined);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  if (socket === undefined) throw new Error("no socket was opened");
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- @effect/vitest is not a dependency of this package, and closed is the Effect the app awaits.
  const failure = Effect.runPromise(Effect.flip(native.closed));
  await vi.waitFor(() => expect(socket.readyState).toBe(1));
  socket.emit("close", { code, reason });
  const error = await failure;
  await native.dispose();
  return error;
};

describe("connectNativeSession close handling", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a 4401 close as a revoked session so the app signs out at once", async () => {
    const error = await closeWith(4401, "session_revoked");
    expect(classifyFailure(error)).toEqual({ kind: "authDead", reason: "session-revoked" });
  });

  it("keeps any other close an outage the app retries", async () => {
    const error = await closeWith(1006, "");
    expect(classifyFailure(error)).toEqual({ kind: "unreachable" });
  });
});

interface SentRequest {
  readonly _tag: "Request";
  readonly id: string;
  readonly tag: string;
}

const sentRequests = (socket: FakeWebSocket): ReadonlyArray<SentRequest> =>
  socket.sent
    .map((frame): unknown => JSON.parse(frame))
    .filter((frame): frame is SentRequest => (frame as { _tag?: unknown })._tag === "Request");

describe("connectNativeSession liveness probe", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends server.probe and never fetches the server config", async () => {
    const native = await connectNativeSession(stored, "1.67.6");
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) throw new Error("no socket was opened");
    await vi.waitFor(() => expect(socket.readyState).toBe(1));
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- @effect/vitest is not a dependency of this package, and probe is the Effect the watchdog awaits.
    const probed = Effect.runPromise(native.session.probe);
    await vi.waitFor(() => expect(sentRequests(socket)).toHaveLength(1));
    const [request] = sentRequests(socket);
    expect(request?.tag).toBe("server.probe");
    socket.emit("message", {
      data: JSON.stringify({
        _tag: "Exit",
        requestId: request?.id,
        exit: { _tag: "Success", value: {} },
      }),
    });
    await expect(probed).resolves.toBeUndefined();
    expect(sentRequests(socket).map((sent) => sent.tag)).not.toContain("server.getConfig");
    await native.dispose();
  });
});
