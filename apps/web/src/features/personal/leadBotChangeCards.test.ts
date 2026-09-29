import {
  PersonalBotId,
  PersonalLeadBotChangeId,
  ThreadId,
  type PersonalLeadBotChange,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";

import {
  deriveLeadBotChangeCards,
  leadBotChangeHasExpired,
  leadBotChangeMinutesLeft,
} from "./leadBotChangeCards";

const leadBotChange = (overrides: Partial<PersonalLeadBotChange> = {}): PersonalLeadBotChange => ({
  changeId: PersonalLeadBotChangeId.make("change-1"),
  changeHash: "hash-1",
  leadBotId: PersonalBotId.make("lead-1"),
  leadName: "CFO",
  action: "update",
  targetBotId: PersonalBotId.make("bot-2"),
  targetName: "Tax",
  team: "Finance",
  threadId: ThreadId.make("thread-1"),
  lines: ["instructions: 412 → 530 chars"],
  fields: [],
  reason: null,
  status: "pending",
  outcome: null,
  createdAt: DateTime.makeUnsafe("2026-09-21T10:00:00.000Z"),
  expiresAt: DateTime.makeUnsafe("2026-09-21T10:10:00.000Z"),
  decidedAt: null,
  ...overrides,
});

it("keeps only this chat's requests, oldest first, with the status as the card kind", () => {
  const cards = deriveLeadBotChangeCards(
    [
      leadBotChange({
        changeId: PersonalLeadBotChangeId.make("late"),
        createdAt: DateTime.makeUnsafe("2026-09-21T12:00:00.000Z"),
      }),
      leadBotChange({
        changeId: PersonalLeadBotChangeId.make("other"),
        threadId: ThreadId.make("thread-2"),
      }),
      leadBotChange({
        changeId: PersonalLeadBotChangeId.make("early"),
        status: "approved",
        createdAt: DateTime.makeUnsafe("2026-09-21T09:00:00.000Z"),
      }),
    ],
    "thread-1",
  );
  expect(cards.map((card) => [card.changeId, card.kind])).toEqual([
    ["early", "approved"],
    ["late", "pending"],
  ]);
  expect(cards[0]!.createdAtMs).toBe(Date.parse("2026-09-21T09:00:00.000Z"));
});

it("carries each settled state through unchanged", () => {
  const statuses = ["approved", "declined", "expired", "failed", "superseded"] as const;
  const cards = deriveLeadBotChangeCards(
    statuses.map((status, index) =>
      leadBotChange({
        changeId: PersonalLeadBotChangeId.make(`c${index}`),
        status,
        createdAt: DateTime.makeUnsafe(`2026-09-21T10:0${index}:00.000Z`),
      }),
    ),
    "thread-1",
  );
  expect(cards.map((card) => card.kind)).toEqual([...statuses]);
});

it("treats a pending request past its expiry on this clock as expired", () => {
  const change = leadBotChange();
  expect(leadBotChangeHasExpired(change, Date.parse("2026-09-21T10:09:59.000Z"))).toBe(false);
  expect(leadBotChangeHasExpired(change, Date.parse("2026-09-21T10:10:00.000Z"))).toBe(true);
  expect(leadBotChangeMinutesLeft(change, Date.parse("2026-09-21T10:00:00.000Z"))).toBe(10);
  expect(leadBotChangeMinutesLeft(change, Date.parse("2026-09-21T10:09:50.000Z"))).toBe(1);
});
