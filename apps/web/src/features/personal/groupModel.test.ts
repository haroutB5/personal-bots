import {
  PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
  PersonalGroup,
  PersonalGroupRound,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  activeGroupMembers,
  filterGroups,
  groupLastActivityMs,
  groupMemberThreadIds,
  groupPreviewLine,
  groupRoundCard,
  groupStatusLine,
  groupSubtitle,
  groupSystemLabel,
  isGroupRoundLive,
  readGroupMarker,
  roundForGroup,
} from "./groupModel";

const decodeGroup = Schema.decodeUnknownSync(PersonalGroup);
const decodeRound = Schema.decodeUnknownSync(PersonalGroupRound);

const NAMES: Record<string, string> = {
  "bot-ada": "Ada",
  "bot-grace": "Grace",
  "bot-alan": "Alan",
};
const nameOf = (botId: string) => NAMES[botId] ?? null;

function member(botId: string, sortOrder: number, extra: Record<string, unknown> = {}) {
  return {
    groupId: "group-1",
    botId,
    threadId: `member-thread-${botId}`,
    role: "member",
    sortOrder,
    deliveredSeq: 0,
    joinedAt: "2026-09-19T09:00:00.000Z",
    leftAt: null,
    ...extra,
  };
}

function group(overrides: Record<string, unknown> = {}) {
  return decodeGroup({
    groupId: "group-1",
    name: "Launch crew",
    description: "",
    threadId: "group-thread-1",
    maxBotTurns: 6,
    members: [member("bot-grace", 1), member("bot-ada", 0)],
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T09:00:00.000Z",
    archivedAt: null,
    ...overrides,
  });
}

function round(overrides: Record<string, unknown> = {}) {
  return decodeRound({
    roundId: "round-1",
    groupId: "group-1",
    triggerMessageId: "message-1",
    status: "running",
    budgetRemaining: 4,
    queue: [],
    spoken: [],
    activeBotId: null,
    activeThreadId: null,
    activeMessageId: null,
    relayedChars: 0,
    availableAt: null,
    deadlineAt: "2026-09-19T09:10:00.000Z",
    errorMessage: null,
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T09:00:00.000Z",
    ...overrides,
  });
}

const marker = {
  groupId: "group-1",
  seq: 7,
  roundId: "round-1",
  speaker: { kind: "bot", botId: "bot-ada", name: "Ada" },
};

describe("readGroupMarker", () => {
  it("reads the speaker straight off the message's context", () => {
    const read = readGroupMarker({
      context: {
        records: [{ kind: PERSONAL_GROUP_MESSAGE_CONTEXT_KIND, payload: marker }],
      } as never,
    });
    expect(read?.speaker).toEqual({ kind: "bot", botId: "bot-ada", name: "Ada" });
    expect(read?.seq).toBe(7);
  });

  it("ignores records of other kinds, and messages with no context at all", () => {
    expect(readGroupMarker({})).toBeNull();
    expect(
      readGroupMarker({
        context: { records: [{ kind: "personal-task", payload: { taskId: "t-1" } }] } as never,
      }),
    ).toBeNull();
  });

  it("falls back to plain rendering when a marker of this kind does not decode", () => {
    // Forward compatibility: a future marker shape must not crash the transcript
    // or invent a speaker.
    expect(
      readGroupMarker({
        context: {
          records: [{ kind: PERSONAL_GROUP_MESSAGE_CONTEXT_KIND, payload: { seq: "soon" } }],
        } as never,
      }),
    ).toBeNull();
  });

  it("reads the system and user speakers too", () => {
    const system = readGroupMarker({
      context: {
        records: [
          {
            kind: PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
            payload: { ...marker, speaker: { kind: "system", event: "member-added" } },
          },
        ],
      } as never,
    });
    expect(system?.speaker).toEqual({ kind: "system", event: "member-added" });
  });
});

describe("group membership", () => {
  it("orders members by sortOrder and drops the ones that left", () => {
    const withLeaver = group({
      members: [
        member("bot-grace", 1),
        member("bot-ada", 0),
        member("bot-alan", 2, { leftAt: "2026-09-19T09:05:00.000Z" }),
      ],
    });
    expect(activeGroupMembers(withLeaver).map((entry) => entry.botId)).toEqual([
      "bot-ada",
      "bot-grace",
    ]);
    expect(groupSubtitle(withLeaver, nameOf)).toBe("Ada, Grace");
  });

  it("says so rather than showing an empty subtitle when nobody is left", () => {
    expect(groupSubtitle(group({ members: [] }), nameOf)).toBe("No bots yet");
  });

  it("collects every member thread, including those of members who left", () => {
    // The hide-from-bot-chats filter has to cover a thread whose member has
    // since left: the transcript is still the group's, not a chat the owner had.
    const left = group({
      members: [member("bot-ada", 0), member("bot-alan", 1, { leftAt: "2026-09-19T09:05:00Z" })],
    });
    expect([...groupMemberThreadIds([left])].toSorted()).toEqual([
      "member-thread-bot-ada",
      "member-thread-bot-alan",
    ]);
  });

  it("skips members that never spoke and so have no thread", () => {
    const silent = group({ members: [member("bot-ada", 0, { threadId: null })] });
    expect(groupMemberThreadIds([silent]).size).toBe(0);
  });
});

describe("filterGroups", () => {
  it("matches the group's own name and its members' names", () => {
    const groups = [group(), group({ groupId: "group-2", name: "Ops", members: [] })];
    expect(filterGroups(groups, "launch", nameOf).map((entry) => entry.groupId)).toEqual([
      "group-1",
    ]);
    expect(filterGroups(groups, "grace", nameOf).map((entry) => entry.groupId)).toEqual([
      "group-1",
    ]);
    expect(filterGroups(groups, "zzz", nameOf)).toEqual([]);
    expect(filterGroups(groups, "  ", nameOf)).toHaveLength(2);
  });
});

describe("group activity and rounds", () => {
  it("orders rows by the group's own updatedAt, which a rename also bumps", () => {
    expect(groupLastActivityMs(group())).toBe(Date.parse("2026-09-19T09:00:00.000Z"));
    expect(groupLastActivityMs(group({ updatedAt: "2026-09-19T09:30:00.000Z" }))).toBe(
      Date.parse("2026-09-19T09:30:00.000Z"),
    );
  });

  it("previews the newest message's first non-empty line, and says so when there is none", () => {
    expect(groupPreviewLine(group())).toBe("No messages yet");
    const spoken = group({
      newestMessage: { id: "m-1", role: "assistant", text: "\n  Morning all\nsecond line" },
    });
    expect(groupPreviewLine(spoken)).toBe("Morning all");
  });

  it("finds a group's round and knows which statuses still own the group", () => {
    const rounds = [round({ roundId: "r-other", groupId: "group-9" }), round()];
    expect(roundForGroup(rounds, "group-1")?.roundId).toBe("round-1");
    expect(roundForGroup(rounds, "group-none")).toBeNull();
    expect(isGroupRoundLive(round())).toBe(true);
    expect(isGroupRoundLive(round({ status: "waiting_provider" }))).toBe(true);
    expect(isGroupRoundLive(round({ status: "paused_budget" }))).toBe(false);
    expect(isGroupRoundLive(null)).toBe(false);
  });

  it("names the speaking member in the row status", () => {
    expect(groupStatusLine(round({ activeBotId: "bot-ada" }), nameOf)).toEqual({
      label: "Ada is replying",
      tone: "normal",
    });
    expect(groupStatusLine(round(), nameOf).label).toBe("Working");
    expect(groupStatusLine(null, nameOf)).toEqual({ label: "Ready", tone: "normal" });
    expect(groupStatusLine(round({ status: "paused_budget" }), nameOf).tone).toBe("review");
    // A finished round is not a status worth showing: the group is simply ready.
    expect(groupStatusLine(round({ status: "completed" }), nameOf).label).toBe("Ready");
  });
});

describe("groupRoundCard", () => {
  it("shows Continue only when the round ran out of replies", () => {
    const card = groupRoundCard(round({ status: "paused_budget" }), nameOf);
    expect(card?.action).toBe("Continue");
    expect(card?.tone).toBe("review");
  });

  it("names the throttled member and offers Retry", () => {
    const card = groupRoundCard(
      round({ status: "waiting_provider", activeBotId: "bot-grace", errorMessage: "429" }),
      nameOf,
    );
    expect(card?.title).toBe("Grace is rate limited");
    expect(card?.detail).toBe("429");
    expect(card?.action).toBe("Retry");
  });

  it("reports a stopped or interrupted round without offering an action", () => {
    expect(groupRoundCard(round({ status: "stopped" }), nameOf)).toEqual({
      tone: "neutral",
      title: "You stopped the group",
      detail: null,
      action: null,
    });
    expect(groupRoundCard(round({ status: "interrupted" }), nameOf)?.action).toBeNull();
  });

  it("stays out of the way for rounds the owner has nothing to do about", () => {
    expect(groupRoundCard(null, nameOf)).toBeNull();
    expect(groupRoundCard(round({ status: "running" }), nameOf)).toBeNull();
    expect(groupRoundCard(round({ status: "completed" }), nameOf)).toBeNull();
    // A resolved vote parks the round, but its card is the vote tally's, not this one's.
    expect(groupRoundCard(round({ status: "paused_vote" }), nameOf)).toBeNull();
  });
});

describe("groupSystemLabel", () => {
  it("prefers the server's own sentence", () => {
    expect(groupSystemLabel("member-added", "  \nAda joined the group")).toBe(
      "Ada joined the group",
    );
  });

  it("falls back to the event's vocabulary when the row has no text", () => {
    expect(groupSystemLabel("round-stopped", "")).toBe("You stopped the group");
  });
});
