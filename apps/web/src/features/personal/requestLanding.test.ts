import { describe, expect, it } from "vite-plus/test";

import type { ConversationItem } from "./conversationModel";
import {
  findRequestItemId,
  isPendingRequestItem,
  openRequestLandingItemId,
} from "./requestLanding";

const item = (id: string, extra: Record<string, unknown>): ConversationItem =>
  ({ id, ...extra }) as never;

const message = (id: string): ConversationItem =>
  item(id, { kind: "message", message: { id, role: "assistant", text: "hi" } });

describe("findRequestItemId", () => {
  it("finds the item that carries the request, whatever its kind", () => {
    const items = [
      message("m1"),
      item("secret:req-9", { kind: "secret", card: { kind: "pending", requestId: "req-9" } }),
      item("question:req-1", { kind: "question", card: { kind: "pending", requestId: "req-1" } }),
    ];
    expect(findRequestItemId(items, "req-9")).toBe("secret:req-9");
    expect(findRequestItemId(items, "req-1")).toBe("question:req-1");
    expect(findRequestItemId(items, "nope")).toBeNull();
  });
});

describe("openRequestLandingItemId", () => {
  it("picks the newest open request card in the thread", () => {
    const items = [
      item("login:req-1", { kind: "login", request: { requestId: "req-1", status: "pending" } }),
      message("m1"),
      item("secret:req-2", { kind: "secret", card: { kind: "pending", requestId: "req-2" } }),
    ];
    expect(openRequestLandingItemId(items)).toBe("secret:req-2");
  });

  it("leaves the docked question and the pinned approval out of it", () => {
    const items = [
      item("secret:req-2", { kind: "secret", card: { kind: "pending", requestId: "req-2" } }),
      item("question:req-3", { kind: "question", card: { kind: "pending", requestId: "req-3" } }),
    ];
    expect(openRequestLandingItemId(items)).toBe("secret:req-2");
    expect(openRequestLandingItemId([items[1]!])).toBeNull();
  });

  it("ignores cards that are already answered or closed", () => {
    const items = [
      item("secret:req-1", { kind: "secret", card: { kind: "provided", requestId: "req-1" } }),
      item("login:req-2", { kind: "login", request: { requestId: "req-2", status: "provided" } }),
      item("memory-change:3", { kind: "memory-change", card: { changeId: 3, pending: false } }),
    ];
    expect(openRequestLandingItemId(items)).toBeNull();
  });

  it("counts a pending memory card and a pending connection approval", () => {
    const items = [
      item("memory-change:3", { kind: "memory-change", card: { changeId: 3, pending: true } }),
      item("connection-approval:a1", {
        kind: "connection-approval",
        card: { kind: "pending", approvalId: "a1" },
      }),
    ];
    expect(openRequestLandingItemId(items)).toBe("connection-approval:a1");
    expect(isPendingRequestItem(items[0]!)).toBe(true);
    expect(isPendingRequestItem(message("m1"))).toBe(false);
  });
});
