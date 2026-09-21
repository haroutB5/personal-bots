import {
  ConnectionId,
  PersonalBotId,
  PersonalConnectionApprovalId,
  ThreadId,
  type PersonalConnectionApproval,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import {
  approvalHasExpired,
  deriveConnectionApprovalCards,
  threadIdsAwaitingApproval,
} from "./connectionApprovalCards";

const approval = (
  key: string,
  threadId: string,
  createdAt: string,
  summary = "Deploy matchday to production",
): PersonalConnectionApproval => ({
  approvalId: PersonalConnectionApprovalId.make(key),
  connectionId: ConnectionId.make("connection-1"),
  vendorId: "vercel",
  operationId: "vercel.deploy",
  actionDigest: `digest-${key}`,
  riskReason: "deployment",
  summary,
  targetResources: ["matchday"],
  credentialVersion: 1,
  threadId: ThreadId.make(threadId),
  botId: PersonalBotId.make("bot-1"),
  taskId: null,
  status: "pending",
  createdAt: DateTime.makeUnsafe(createdAt),
  expiresAt: DateTime.makeUnsafe("2026-09-21T11:00:00.000Z"),
  decidedAt: null,
  executedAt: null,
  executionOutcome: null,
});

it("shows only the open chat's pending approvals, oldest first", () => {
  const mine = approval("a", "thread-1", "2026-09-21T10:05:00.000Z");
  const older = approval(
    "b",
    "thread-1",
    "2026-09-21T10:00:00.000Z",
    "Create repository hbots-demo",
  );
  const elsewhere = approval("c", "thread-2", "2026-09-21T10:01:00.000Z");

  const cards = deriveConnectionApprovalCards(
    [mine, older, elsewhere],
    "thread-1",
    new Map(),
    new Map(),
  );

  expect(cards.map((card) => card.approvalId)).toEqual(["b", "a"]);
  expect(cards.every((card) => card.kind === "pending")).toBe(true);
});

it("keeps a decided card in the transcript instead of letting it vanish", () => {
  const decided = approval("a", "thread-1", "2026-09-21T10:05:00.000Z");

  // The server drops it from the pending list the moment it is answered.
  const cards = deriveConnectionApprovalCards(
    [],
    "thread-1",
    new Map([["a", decided]]),
    new Map([["a", "approved" as const]]),
  );

  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({
    kind: "approved",
    summary: "Deploy matchday to production",
    vendorId: "vercel",
  });
});

it("calls an approval settled elsewhere closed rather than guessing an outcome", () => {
  const gone = approval("a", "thread-1", "2026-09-21T10:05:00.000Z");

  const cards = deriveConnectionApprovalCards([], "thread-1", new Map([["a", gone]]), new Map());

  expect(cards[0]!.kind).toBe("closed");
});

it("reports the chats a bot is parked on an approval in", () => {
  const first = approval("a", "thread-1", "2026-09-21T10:05:00.000Z");
  const second = approval("b", "thread-2", "2026-09-21T10:06:00.000Z");

  expect(threadIdsAwaitingApproval([first, second])).toEqual(new Set(["thread-1", "thread-2"]));
});

it("treats a pending approval past its moment as expired", () => {
  const live = approval("a", "thread-1", "2026-09-21T10:05:00.000Z");
  const expiresAtMs = DateTime.toEpochMillis(live.expiresAt);

  expect(approvalHasExpired(live, expiresAtMs - 1)).toBe(false);
  // Lazy server-side sweeping means a dead approval can still be listed.
  expect(approvalHasExpired(live, expiresAtMs)).toBe(true);
});
