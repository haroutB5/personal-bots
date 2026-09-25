import { describe, expect, it } from "vite-plus/test";

import type { PendingOutgoingMessage } from "./MessageList";
import { pendingForThread } from "./pendingOutgoing";

// Harout's case (2026-09-25): "Yes fix that" sent in the CTO chat, then the
// app moved to Backend's fresh task chat while the send was still in flight.
const ctoThread = "2c07648e-cto";
const backendThread = "b84e851d-backend";
const sentToCto: PendingOutgoingMessage = {
  id: "d4fb8048-msg",
  threadId: ctoThread,
  text: "Yes fix that",
  createdAt: "2026-09-25T21:49:51.000Z",
  attachments: [],
};
const backendMessages = [{ id: "task-from-cto" }, { id: "backend-first-reply" }];

describe("pending outgoing rows", () => {
  it("never shows a row sent from one chat in another chat", () => {
    expect(pendingForThread([sentToCto], backendThread, backendMessages)).toEqual([]);
  });

  it("keeps showing the row in the chat it was sent from until it is echoed", () => {
    expect(pendingForThread([sentToCto], ctoThread, [{ id: "earlier" }])).toEqual([sentToCto]);
  });

  it("resolves the row in its own chat once the server echoes the same id", () => {
    expect(pendingForThread([sentToCto], ctoThread, [{ id: "d4fb8048-msg" }])).toEqual([]);
  });

  it("shows each chat only its own rows when both have one in flight", () => {
    const sentToBackend = { ...sentToCto, id: "other", threadId: backendThread, text: "Hi" };
    const both = [sentToCto, sentToBackend];
    expect(pendingForThread(both, backendThread, backendMessages)).toEqual([sentToBackend]);
    expect(pendingForThread(both, ctoThread, [])).toEqual([sentToCto]);
  });
});
