import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { describe, expect, it } from "vite-plus/test";

import { NETWORK_BLOCKING_HINT } from "./network.ts";
import { isTransportConnectionErrorMessage, sanitizeThreadErrorMessage } from "./transport.ts";

describe("isTransportConnectionErrorMessage", () => {
  it("returns true for React Native disconnected socket errors", () => {
    expect(
      isTransportConnectionErrorMessage(
        "The operation couldn't be completed. Socket is not connected",
      ),
    ).toBe(true);
  });

  it("recognizes relay connection errors that carry the network hint", () => {
    for (const sentence of [
      "Relay environment disconnected.",
      "Relay environment stopped responding.",
      "Relay environment could not establish a WebSocket connection.",
    ]) {
      expect(isTransportConnectionErrorMessage(`${sentence} ${NETWORK_BLOCKING_HINT}`)).toBe(true);
    }
    expect(
      isTransportConnectionErrorMessage(
        "Your ChatGPT connection expired or was disconnected. Sign in again.",
      ),
    ).toBe(false);
  });
});

describe("isTransportConnectionErrorMessage on the RPC client's socket errors", () => {
  const cause = new Error("link lost");
  const reasons = [
    new Socket.SocketReadError({ cause }),
    new Socket.SocketWriteError({ cause }),
    new Socket.SocketOpenError({ kind: "Unknown", cause }),
    new Socket.SocketOpenError({ kind: "Timeout", cause }),
    new Socket.SocketCloseError({ code: 1006 }),
    new Socket.SocketCloseError({ code: 1001, closeReason: "going away" }),
  ] as const;

  it.each(reasons.map((reason) => [reason._tag, reason] as const))(
    "treats the message of an RpcClientError wrapping %s as a dropped link",
    (_tag, reason) => {
      const message = new RpcClientError.RpcClientError({ reason }).message;
      expect(isTransportConnectionErrorMessage(message)).toBe(true);
    },
  );

  it("still shows a server answer and a TLS upgrade failure", () => {
    expect(isTransportConnectionErrorMessage("Personal bots thread creation failed.")).toBe(false);
    expect(
      isTransportConnectionErrorMessage(
        new RpcClientError.RpcClientError({ reason: new Socket.SocketUpgradeError({}) }).message,
      ),
    ).toBe(false);
  });
});

describe("sanitizeThreadErrorMessage", () => {
  it("strips transport errors", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: oops")).toBeNull();
  });
});
