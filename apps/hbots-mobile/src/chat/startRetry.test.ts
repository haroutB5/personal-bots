import { describe, expect, it, vi } from "vite-plus/test";

import { isNotConnectedFailure, startUntilConnected, UNREACHABLE_MESSAGE } from "./startRetry";
import type { StartChatResult } from "./useStartChat";

const NOT_CONNECTED: StartChatResult = { kind: "failed", message: "Laptop is not connected." };

/** A server that records which thread ids were created and refuses while the link is down. */
function laptop(upAfterCalls: number) {
  const created: string[] = [];
  let calls = 0;
  const attempt = (threadId: string) => async (): Promise<StartChatResult> => {
    calls += 1;
    if (calls <= upAfterCalls) return NOT_CONNECTED;
    created.push(threadId);
    return { kind: "started", threadId };
  };
  return { created, attempt, calls: () => calls };
}

const instantly = { sleep: async () => undefined };

describe("starting a chat after the app sat in the background", () => {
  it("waits for the connection, shows connecting, and creates the chat exactly once", async () => {
    const server = laptop(3);
    const onConnecting = vi.fn();

    const result = await startUntilConnected(server.attempt("thread-1"), {
      ...instantly,
      onConnecting,
    });

    expect(result).toEqual({ kind: "started", threadId: "thread-1" });
    expect(server.created).toEqual(["thread-1"]);
    expect(server.calls()).toBe(4);
    expect(onConnecting).toHaveBeenCalledTimes(3);
  });

  it("starts at once when the connection is already up", async () => {
    const server = laptop(0);
    const onConnecting = vi.fn();
    await startUntilConnected(server.attempt("t"), { ...instantly, onConnecting });

    expect(onConnecting).not.toHaveBeenCalled();
    expect(server.created).toEqual(["t"]);
  });

  it("gives up after the bounded wait and says the laptop is unreachable", async () => {
    const server = laptop(1_000);
    const sleeps: number[] = [];

    const result = await startUntilConnected(server.attempt("t"), {
      sleep: async (ms) => void sleeps.push(ms),
      onConnecting: () => undefined,
      delays: [10, 20],
    });

    expect(result).toEqual({ kind: "failed", message: UNREACHABLE_MESSAGE });
    expect(sleeps).toEqual([10, 20]);
    expect(server.created).toEqual([]);
    expect(server.calls()).toBe(3);
  });

  it("does not retry a failure that may have reached the server", async () => {
    const attempt = vi.fn(
      async (): Promise<StartChatResult> => ({
        kind: "failed",
        message: "Couldn't start a chat. Try again.",
      }),
    );

    const result = await startUntilConnected(attempt, { ...instantly, onConnecting: vi.fn() });

    expect(result.kind).toBe("failed");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the screen was left, so no chat appears behind the user's back", async () => {
    const server = laptop(1_000);
    let left = false;

    await startUntilConnected(server.attempt("t"), {
      sleep: async () => void (left = true),
      onConnecting: () => undefined,
      abandoned: () => left,
    });

    expect(server.calls()).toBe(1);
    expect(server.created).toEqual([]);
  });

  it("recognises the connection layer's message and nothing broader", () => {
    expect(isNotConnectedFailure("Laptop is not connected.")).toBe(true);
    expect(isNotConnectedFailure("Laptop stopped responding for 30s.")).toBe(false);
    expect(isNotConnectedFailure("Couldn't start a chat. Try again.")).toBe(false);
  });
});
