import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { classifyFailure, type Failure } from "./failure";
import { connectPersonalRpc } from "./rpc";

type Listener = (event: { readonly code?: number; readonly reason?: string }) => void;

class StubWebSocket {
  static latest: StubWebSocket | null = null;
  readyState = 1;
  binaryType = "blob";
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    StubWebSocket.latest = this;
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(): void {}

  close(): void {}

  serverCloses(code: number, reason: string): void {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) {
      listener({ code, reason });
    }
  }
}

async function failureAfterServerCloses(code: number, reason: string): Promise<Failure> {
  vi.stubGlobal("WebSocket", StubWebSocket);
  const rpc = await connectPersonalRpc("wss://relay.example.test/ws");
  const pending = rpc.listBots().then(
    () => {
      throw new Error("expected the list to fail");
    },
    (cause: unknown) => cause,
  );
  await vi.waitFor(() => expect(StubWebSocket.latest).not.toBeNull());
  StubWebSocket.latest?.serverCloses(code, reason);
  const failure = classifyFailure(await pending);
  await rpc.dispose();
  return failure;
}

afterEach(() => {
  StubWebSocket.latest = null;
  vi.unstubAllGlobals();
});

describe("a WebSocket close from the server", () => {
  it("counts close 4401 session_revoked as signed out", async () => {
    expect(await failureAfterServerCloses(4401, "session_revoked")).toEqual({
      kind: "authDead",
      reason: "session-revoked",
    });
  });

  it.each([
    [1000, "normal"],
    [1001, "going away"],
    [1006, ""],
    [4000, "other"],
  ])("counts close %i as unreachable and keeps the saved link", async (code, reason) => {
    expect(await failureAfterServerCloses(code, reason)).toEqual({ kind: "unreachable" });
  });
});
