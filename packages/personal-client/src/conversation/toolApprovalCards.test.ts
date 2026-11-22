import {
  NodeId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { placeToolApprovalCards, type ConversationItem } from "./conversationModel.ts";
import {
  deriveToolApprovalCards,
  TOOL_APPROVAL_PREVIEW_CHARS,
  toolApprovalLabel,
  toolApprovalPreview,
} from "./toolApprovalCards.ts";

const threadId = ThreadId.make("thread-1");
const askedAt = DateTime.makeUnsafe("2026-11-22T19:11:20.980Z");

const approvalItem = (
  requestId: string,
  prompt: string,
  reason?: string,
): OrchestrationV2TurnItem =>
  ({
    threadId,
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    title: null,
    startedAt: askedAt,
    completedAt: null,
    updatedAt: askedAt,
    id: TurnItemId.make(`item-${requestId}`),
    ordinal: 1,
    status: "waiting",
    type: "approval_request",
    requestId: RuntimeRequestId.make(requestId),
    requestKind: "command",
    prompt,
    ...(reason === undefined ? {} : { reason }),
    fullAccessOverride: "provider_check",
  }) as OrchestrationV2TurnItem;

const request = (
  id: string,
  status: OrchestrationV2RuntimeRequest["status"] = "pending",
): OrchestrationV2RuntimeRequest =>
  ({
    id: RuntimeRequestId.make(id),
    nodeId: NodeId.make(`node-${id}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status,
    responseCapability: {
      type: "live",
      providerSessionId: ProviderSessionId.make("session-1"),
      supportsFeedback: true,
    },
    createdAt: askedAt,
    resolvedAt: status === "pending" ? null : askedAt,
  }) as OrchestrationV2RuntimeRequest;

describe("deriveToolApprovalCards", () => {
  it("shows a pending command approval with its command and reason", () => {
    const cards = deriveToolApprovalCards({
      runtimeRequests: [request("r1")],
      turnItems: [approvalItem("r1", "pgrep -a 'qemu-system|netsimd'; echo exit=$?", "Unsure")],
    });
    expect(cards).toEqual([
      {
        requestId: "r1",
        createdAt: "2026-11-22T19:11:20.980Z",
        requestKind: "command",
        detail: "pgrep -a 'qemu-system|netsimd'; echo exit=$?",
        reason: "Unsure",
        appName: null,
        answerable: true,
        supportsFeedback: true,
      },
    ]);
    expect(toolApprovalLabel(cards[0]!)).toBe("Run a command");
  });

  it("drops the card once the request resolves in any way", () => {
    for (const status of ["resolved", "cancelled", "expired"] as const) {
      expect(
        deriveToolApprovalCards({
          runtimeRequests: [request("r1", status as never)],
          turnItems: [approvalItem("r1", "ls")],
        }),
      ).toEqual([]);
    }
  });

  it("ignores questions, which have their own card", () => {
    const question = { ...request("q1"), kind: "user_input" } as OrchestrationV2RuntimeRequest;
    expect(deriveToolApprovalCards({ runtimeRequests: [question], turnItems: [] })).toEqual([]);
    expect(deriveToolApprovalCards(null)).toEqual([]);
  });
});

describe("toolApprovalPreview", () => {
  it("truncates long commands until expanded", () => {
    const long = "x".repeat(TOOL_APPROVAL_PREVIEW_CHARS + 50);
    expect(toolApprovalPreview(long, false).truncated).toBe(true);
    expect(toolApprovalPreview(long, false).text.endsWith("…")).toBe(true);
    expect(toolApprovalPreview(long, true)).toEqual({ text: long, truncated: false });
    expect(toolApprovalPreview("ls", false)).toEqual({ text: "ls", truncated: false });
  });
});

describe("placeToolApprovalCards", () => {
  it("puts pending approvals at the end of the chat", () => {
    const items: ConversationItem[] = [
      { kind: "divider", id: "d1", at: new Date("2026-11-22T20:00:00.000Z") },
    ];
    const cards = deriveToolApprovalCards({
      runtimeRequests: [request("r1")],
      turnItems: [approvalItem("r1", "ls")],
    });
    const placed = placeToolApprovalCards(items, cards);
    expect(placed.map((item) => item.id)).toEqual(["d1", "tool-approval:r1"]);
  });
});
