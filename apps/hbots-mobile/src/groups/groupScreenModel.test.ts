import type { PersonalBot, PersonalGroup, PersonalGroupRound } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  groupChatsSections,
  groupComposerMode,
  groupMembersError,
  groupMenuActions,
  groupNameError,
  groupRowModel,
  groupScreenState,
} from "./groupScreenModel";

const NOW = Date.parse("2026-11-05T20:00:00.000Z");

function group(input: {
  readonly groupId: string;
  readonly name: string;
  readonly archived?: boolean;
  readonly updatedAt?: string;
  readonly newestText?: string | null;
  readonly hidden?: boolean;
  readonly memberIds?: ReadonlyArray<string>;
}): PersonalGroup {
  const memberIds = input.memberIds ?? ["bot-a", "bot-b"];
  return {
    groupId: input.groupId,
    name: input.name,
    description: "",
    threadId: `thread-${input.groupId}`,
    maxBotTurns: 6,
    members: memberIds.map((botId, index) => ({
      groupId: input.groupId,
      botId,
      threadId: `thread-${botId}`,
      role: "member",
      sortOrder: index,
      deliveredSeq: 0,
      joinedAt: DateTime.makeUnsafe("2026-11-01T10:00:00.000Z"),
      leftAt: null,
    })),
    newestMessage:
      input.hidden === true
        ? { hidden: true }
        : input.newestText === null
          ? null
          : { text: input.newestText ?? "Morning all", hidden: false },
    createdAt: DateTime.makeUnsafe("2026-11-01T10:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe(input.updatedAt ?? "2026-11-05T19:55:00.000Z"),
    archivedAt: input.archived === true ? DateTime.makeUnsafe("2026-11-04T10:00:00.000Z") : null,
  } as unknown as PersonalGroup;
}

function bot(botId: string, name: string): PersonalBot {
  return {
    botId,
    name,
    title: "",
    description: "",
    instructions: "",
    enabled: true,
    sortOrder: 0,
  } as unknown as PersonalBot;
}

function round(
  status: PersonalGroupRound["status"],
  activeBotId: string | null,
): PersonalGroupRound {
  return {
    roundId: "round-1",
    groupId: "group-1",
    triggerMessageId: "message-1",
    status,
    budgetRemaining: 0,
    queue: [],
    spoken: [],
    activeBotId,
    activeThreadId: null,
    activeMessageId: null,
    relayedChars: 0,
    availableAt: null,
    deadlineAt: DateTime.makeUnsafe("2026-11-05T20:10:00.000Z"),
    errorMessage: null,
    createdAt: DateTime.makeUnsafe("2026-11-05T19:58:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-11-05T19:58:00.000Z"),
  } as unknown as PersonalGroupRound;
}

const BOTS = [bot("bot-a", "Ada"), bot("bot-b", "Grace")];

describe("groupRowModel", () => {
  it("names the members, previews the newest line and says who is replying", () => {
    const row = groupRowModel({
      group: group({ groupId: "group-1", name: "Launch crew" }),
      bots: BOTS,
      round: round("running", "bot-b"),
      nowMs: NOW,
    });
    expect(row).toMatchObject({
      name: "Launch crew",
      subtitle: "Ada, Grace",
      preview: "Morning all",
      statusLabel: "Grace is replying",
      live: true,
      archived: false,
      timeLabel: "5m",
    });
  });

  it("reads Ready with no round and says Archived for a read-only group", () => {
    const idle = groupRowModel({
      group: group({ groupId: "group-1", name: "Launch crew" }),
      bots: BOTS,
      round: null,
      nowMs: NOW,
    });
    expect(idle.statusLabel).toBe("Ready");
    expect(idle.timeLabel).toBe("5m");

    const archived = groupRowModel({
      group: group({ groupId: "group-1", name: "Launch crew", archived: true }),
      bots: BOTS,
      round: round("paused_budget", null),
      nowMs: NOW,
    });
    expect(archived).toMatchObject({ statusLabel: "Archived", archived: true, live: false });
  });

  it("shows the hidden-preview line instead of text the owner hid", () => {
    const hidden = group({ groupId: "group-1", name: "Launch crew", hidden: true });
    const row = groupRowModel({ group: hidden, bots: BOTS, round: null, nowMs: NOW });
    expect(row.preview).toBe("Preview hidden");
  });
});

describe("groupChatsSections", () => {
  it("splits archived groups out and orders each by newest activity", () => {
    const sections = groupChatsSections({
      groups: [
        group({
          groupId: "older",
          name: "Older",
          updatedAt: "2026-11-05T18:00:00.000Z",
        }),
        group({ groupId: "newer", name: "Newer", updatedAt: "2026-11-05T19:59:00.000Z" }),
      ],
      archivedGroups: [group({ groupId: "archived", name: "Archived", archived: true })],
      rounds: [],
      bots: BOTS,
      nowMs: NOW,
    });
    expect(sections.groups.map((row) => row.groupId)).toEqual(["newer", "older"]);
    expect(sections.archived.map((row) => row.groupId)).toEqual(["archived"]);
  });
});

describe("groupScreenState", () => {
  it("waits for the list before calling a missing group gone", () => {
    expect(groupScreenState({ listLoaded: false, listError: null, groupExists: false })).toEqual({
      kind: "loading",
    });
    expect(groupScreenState({ listLoaded: true, listError: null, groupExists: false })).toEqual({
      kind: "gone",
    });
    expect(groupScreenState({ listLoaded: true, listError: null, groupExists: true })).toEqual({
      kind: "ready",
    });
    expect(groupScreenState({ listLoaded: true, listError: "offline", groupExists: true })).toEqual(
      { kind: "error", message: "offline" },
    );
  });
});

describe("groupMenuActions", () => {
  const keys = (actions: ReturnType<typeof groupMenuActions>) =>
    actions.map((action) => action.key);

  it("offers Stop only while a round owns the group", () => {
    expect(
      keys(groupMenuActions({ live: true, archived: false, pinned: false, unarchiving: false })),
    ).toContain("stop");
    expect(
      keys(groupMenuActions({ live: false, archived: false, pinned: false, unarchiving: false })),
    ).not.toContain("stop");
  });

  it("swaps pin and snooze for Unarchive once the group is archived", () => {
    const archived = groupMenuActions({
      live: false,
      archived: true,
      pinned: false,
      unarchiving: false,
    });
    expect(keys(archived)).toEqual(["settings", "unarchive", "delete"]);
    const live = groupMenuActions({
      live: false,
      archived: false,
      pinned: true,
      unarchiving: false,
    });
    expect(live.find((action) => action.key === "pin")?.label).toBe("Unpin group");
    expect(live.at(-1)).toMatchObject({ key: "delete", destructive: true });
  });
});

describe("groupComposerMode", () => {
  it("blocks an archived or empty group and turns Send into Stop", () => {
    expect(groupComposerMode({ archived: true, live: false, memberCount: 2 })).toEqual({
      kind: "blocked",
      reason: "Unarchive to send messages again.",
    });
    expect(groupComposerMode({ archived: false, live: false, memberCount: 0 }).kind).toBe(
      "blocked",
    );
    expect(groupComposerMode({ archived: false, live: true, memberCount: 2 })).toEqual({
      kind: "stop",
    });
    expect(groupComposerMode({ archived: false, live: false, memberCount: 2 })).toEqual({
      kind: "send",
    });
  });
});

describe("group validation", () => {
  it("asks for a name and two bots", () => {
    expect(groupNameError("  ")).toBe("Give the group a name.");
    expect(groupNameError("Launch crew")).toBeNull();
    expect(groupMembersError(1)).toBe("Pick at least two bots. A group of one is a chat.");
    expect(groupMembersError(2)).toBeNull();
  });
});
