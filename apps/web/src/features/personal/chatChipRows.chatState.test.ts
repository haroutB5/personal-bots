import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBotThread, PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildChatChips } from "./chatChipRows";
import { NO_CHAT_SEEN } from "./unreadChats";

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();

const link = (threadId: string, createdHoursAgo: number, extra: Record<string, unknown> = {}) =>
  ({
    botId: "cto",
    threadId,
    archivedAt: null,
    createdAt: DateTime.makeUnsafe(NOW - createdHoursAgo * 3_600_000),
    ...extra,
  }) as unknown as PersonalBotThread;
const shell = (id: string, activityHoursAgo: number) =>
  ({
    id,
    environmentId: "env-1",
    title: `Chat ${id}`,
    updatedAt: iso(NOW - activityHoursAgo * 3_600_000),
    createdAt: iso(NOW - activityHoursAgo * 3_600_000),
    latestUserMessageAt: null,
    latestTurn: null,
    session: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  }) as unknown as EnvironmentThreadShell;

const pinnedAt = DateTime.makeUnsafe(NOW - 86_400_000);
const asleep = DateTime.makeUnsafe(NOW + 3_600_000);

/** A task that made the chat (the task rule reads the id and the creation time). */
const taskOn = (threadId: string, hoursAgo: number): PersonalTask =>
  ({
    taskId: `task-${threadId}`,
    threadId,
    createdAt: DateTime.makeUnsafe(NOW - hoursAgo * 3_600_000),
  }) as unknown as PersonalTask;

function build(links: PersonalBotThread[], current: string, tasks: PersonalTask[] = []) {
  return buildChatChips({
    botId: "cto",
    currentThreadId: current,
    links,
    // The id's number is how many hours ago the chat last had activity.
    shells: links.map((entry) => shell(entry.threadId, Number(entry.threadId.slice(1)))),
    relayThreadIds: new Set(),
    tasks,
    waitingLabels: new Map(),
    seen: NO_CHAT_SEEN,
    nowMs: NOW,
  });
}

describe("chat chips with pinned and snoozed chats", () => {
  it("puts pinned chats first, then the rest, each newest activity first", () => {
    // The id's number is the hours since the chat last had activity: t1 is the newest.
    const model = build(
      [link("t3", 10), link("t9", 8, { pinnedAt }), link("t1", 6), link("t2", 4, { pinnedAt })],
      "t1",
    );
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["t2", "t9", "t1", "t3"]);
    expect(model.chips.map((chip) => chip.pinned)).toEqual([true, true, false, false]);
  });

  it("orders the unpinned chats by activity, not by when they were made", () => {
    const model = build([link("t1", 1), link("t5", 9), link("t3", 5)], "t1");
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["t1", "t3", "t5"]);
    const reversed = build([link("t5", 1), link("t1", 9), link("t3", 5)], "t5");
    expect(reversed.chips.map((chip) => chip.threadId)).toEqual(["t1", "t3", "t5"]);
  });

  it("says a chip is pinned to a screen reader", () => {
    const model = build([link("t1", 5, { pinnedAt }), link("t2", 4)], "t2");
    expect(model.chips[0]?.label).toBe("Chat t1, pinned");
  });

  it("leaves snoozed chats out of the chips and the All count", () => {
    const model = build(
      [link("t1", 5), link("t2", 4), link("t3", 3, { snoozedUntil: asleep })],
      "t1",
    );
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["t1", "t2"]);
    expect(model.openCount).toBe(2);
  });

  it("brings a chat back once its snooze has run out", () => {
    const woken = link("t3", 3, { snoozedUntil: DateTime.makeUnsafe(NOW - 1) });
    const model = build([link("t1", 5), link("t2", 4), woken], "t1");
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["t1", "t2", "t3"]);
  });

  it("keeps a snoozed chat that is open (opened from Snoozed) as a chip while it is open", () => {
    const model = build(
      [link("t1", 5), link("t2", 4), link("t3", 3, { snoozedUntil: asleep })],
      "t3",
    );
    expect(model.chips[0]).toMatchObject({ threadId: "t3", current: true, kind: "chat" });
  });

  it("keeps a pinned task chat as a pinned chip, ahead of the rest", () => {
    // t3 was made for a task and its shell has no user turn, so only the pin makes it the owner's.
    const model = build([link("t1", 6), link("t2", 4), link("t3", 3, { pinnedAt })], "t1", [
      taskOn("t3", 3),
    ]);
    expect(model.chips.map((chip) => [chip.threadId, chip.kind, chip.pinned])).toEqual([
      ["t3", "chat", true],
      ["t1", "chat", false],
      ["t2", "chat", false],
    ]);
    // Not a temporary chip: it stays a chip after the owner switches to another chat.
    expect(model.temporary).toBeNull();
  });

  it("keeps it as the open chat too, with no temporary Task chip", () => {
    const model = build([link("t1", 6), link("t2", 4), link("t3", 3, { pinnedAt })], "t3", [
      taskOn("t3", 3),
    ]);
    expect(model.temporary).toBeNull();
    expect(model.chips[0]).toMatchObject({
      threadId: "t3",
      kind: "chat",
      current: true,
      pinned: true,
    });
  });

  it("still leaves an untouched task chat out of the chips", () => {
    const model = build([link("t1", 6), link("t2", 4), link("t3", 3)], "t1", [taskOn("t3", 3)]);
    expect(model.chips.map((chip) => chip.threadId)).toEqual(["t1", "t2"]);
  });
});
