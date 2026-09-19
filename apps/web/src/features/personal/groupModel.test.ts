import {
  PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
  PersonalBot,
  PersonalGroup,
  PersonalGroupRound,
  PersonalGroupVote,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  activeGroupMembers,
  filterGroups,
  groupDeleteCandidates,
  groupDeleteSummary,
  groupLastActivityMs,
  groupMemberThreadIds,
  groupPreviewLine,
  groupRoundCard,
  groupStatusLine,
  groupSubtitle,
  groupSystemLabel,
  groupVoteCard,
  isGroupRoundLive,
  readGroupMarker,
  roundForGroup,
} from "./groupModel";

const decodeBot = Schema.decodeUnknownSync(PersonalBot);
const decodeGroup = Schema.decodeUnknownSync(PersonalGroup);
const decodeRound = Schema.decodeUnknownSync(PersonalGroupRound);
const decodeVote = Schema.decodeUnknownSync(PersonalGroupVote);

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

function ballot(botId: string, option: string, reason: string) {
  return { voteId: "vote-1", botId, option, reason, createdAt: "2026-09-19T09:05:00.000Z" };
}

function vote(overrides: Record<string, unknown> = {}) {
  return decodeVote({
    voteId: "vote-1",
    groupId: "group-1",
    roundId: "round-1",
    calledByBotId: "bot-ada",
    question: "Ship on Friday?",
    questionNormalised: "friday ship",
    options: ["ship", "wait"],
    status: "decided",
    winningOption: "ship",
    ballots: [ballot("bot-ada", "ship", "the build is green")],
    createdAt: "2026-09-19T09:04:00.000Z",
    decidedAt: "2026-09-19T09:06:00.000Z",
    ...overrides,
  });
}

const parked = round({ status: "paused_vote" });
const MEMBERS = activeGroupMembers(group());

describe("groupVoteCard", () => {
  it("shows every member's choice with its reason, in member order", () => {
    const card = groupVoteCard({
      round: parked,
      votes: [
        vote({
          ballots: [
            ballot("bot-grace", "wait", "the migration is untested"),
            ballot("bot-ada", "ship", "the build is green"),
          ],
        }),
      ],
      members: MEMBERS,
      nameOf,
    });

    expect(card?.question).toBe("Ship on Friday?");
    // Ada is sortOrder 0 even though her ballot arrived second: the card reads
    // like the roster, not like the order the bots happened to answer in.
    expect(card?.ballots).toEqual([
      { botId: "bot-ada", name: "Ada", option: "ship", reason: "the build is green" },
      { botId: "bot-grace", name: "Grace", option: "wait", reason: "the migration is untested" },
    ]);
    expect(card?.abstained).toEqual([]);
  });

  it("names the members that did not vote rather than folding them into a count", () => {
    const card = groupVoteCard({ round: parked, votes: [vote()], members: MEMBERS, nameOf });

    expect(card?.ballots.map((entry) => entry.name)).toEqual(["Ada"]);
    expect(card?.abstained).toEqual(["Grace"]);
    expect(card?.outcome).toBe('The bots chose "ship".');
    expect(card?.canApprove).toBe(true);
  });

  it("offers no Approve on a tie, because there is nothing to approve", () => {
    const card = groupVoteCard({
      round: parked,
      votes: [
        vote({
          winningOption: null,
          ballots: [
            ballot("bot-ada", "ship", "the build is green"),
            ballot("bot-grace", "wait", "the migration is untested"),
          ],
        }),
      ],
      members: MEMBERS,
      nameOf,
    });

    expect(card?.winningOption).toBe(null);
    expect(card?.canApprove).toBe(false);
    expect(card?.outcome).toBe("The bots are tied, so they chose nothing.");
  });

  it("asks nothing when the round is not parked on a vote", () => {
    // Every status but `paused_vote`: the card exists to ask a question, and
    // there is no question unless the round is actually waiting on one.
    for (const status of ["running", "paused_budget", "completed", "stopped", "interrupted"]) {
      expect(
        groupVoteCard({ round: round({ status }), votes: [vote()], members: MEMBERS, nameOf }),
      ).toBeNull();
    }
    expect(groupVoteCard({ round: null, votes: [vote()], members: MEMBERS, nameOf })).toBeNull();
  });

  it("shows only a tally this round is still waiting on", () => {
    // Already answered, so it is no longer a question...
    for (const status of ["approved", "rejected", "expired", "open"]) {
      expect(
        groupVoteCard({ round: parked, votes: [vote({ status })], members: MEMBERS, nameOf }),
      ).toBeNull();
    }
    // ...and a decided vote from another round is not this round's question.
    expect(
      groupVoteCard({
        round: parked,
        votes: [vote({ roundId: "round-0" })],
        members: MEMBERS,
        nameOf,
      }),
    ).toBeNull();
  });

  it("falls back to a generic name for a member whose bot has been deleted", () => {
    const card = groupVoteCard({
      round: parked,
      votes: [vote({ ballots: [ballot("bot-ghost", "ship", "gone")] })],
      members: activeGroupMembers(group({ members: [member("bot-ghost", 0)] })),
      nameOf,
    });

    expect(card?.ballots).toEqual([
      { botId: "bot-ghost", name: "A bot", option: "ship", reason: "gone" },
    ]);
  });
});

describe("groupDeleteCandidates", () => {
  const bot = (botId: string, name: string, extra: Record<string, unknown> = {}) =>
    decodeBot({
      botId,
      name,
      title: "",
      description: "",
      instructions: "",
      avatarShape: "blob",
      avatarColor: "#1A73E8",
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      enabled: true,
      sortOrder: 0,
      team: "assistant",
      lead: false,
      pinned: false,
      createdAt: "2026-09-19T09:00:00.000Z",
      updatedAt: "2026-09-19T09:00:00.000Z",
      ...extra,
    });

  const plain = [bot("bot-ada", "Ada"), bot("bot-grace", "Grace")];

  it("ticks a bot this group alone holds", () => {
    const rows = groupDeleteCandidates({ group: group(), groups: [group()], bots: plain });
    // Member order, i.e. sortOrder: Ada then Grace.
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Grace"]);
    expect(rows.every((row) => row.checked)).toBe(true);
    expect(rows.every((row) => row.reason === null)).toBe(true);
  });

  it("unticks a team lead and says so", () => {
    const rows = groupDeleteCandidates({
      group: group(),
      groups: [group()],
      bots: [bot("bot-ada", "Ada", { lead: true, team: "assistant" }), bot("bot-grace", "Grace")],
    });
    expect(rows[0]).toMatchObject({
      name: "Ada",
      checked: false,
      reason: "Leads the Assistant's team",
    });
    // Only the lead is protected; the other member is still ticked.
    expect(rows[1]).toMatchObject({ name: "Grace", checked: true, reason: null });
  });

  it("unticks a pinned bot", () => {
    const rows = groupDeleteCandidates({
      group: group(),
      groups: [group()],
      bots: [bot("bot-ada", "Ada", { pinned: true }), bot("bot-grace", "Grace")],
    });
    expect(rows[0]).toMatchObject({ checked: false, reason: "Pinned in Chats" });
  });

  it("unticks a bot that is in another group, and names it", () => {
    const other = group({
      groupId: "group-2",
      name: "Side project",
      threadId: "group-thread-2",
      members: [member("bot-grace", 0, { groupId: "group-2" })],
    });
    const rows = groupDeleteCandidates({ group: group(), groups: [group(), other], bots: plain });
    expect(rows[0]).toMatchObject({ name: "Ada", checked: true, reason: null });
    expect(rows[1]).toMatchObject({
      name: "Grace",
      checked: false,
      reason: "Also in Side project",
    });
  });

  it("counts the other groups when there is more than one", () => {
    const other = (id: string) =>
      group({
        groupId: id,
        name: `Group ${id}`,
        threadId: `group-thread-${id}`,
        members: [member("bot-grace", 0, { groupId: id })],
      });
    const rows = groupDeleteCandidates({
      group: group(),
      groups: [group(), other("group-2"), other("group-3")],
      bots: plain,
    });
    expect(rows[1]).toMatchObject({ checked: false, reason: "Also in 2 other groups" });
  });

  it("ignores a member that already left the other group", () => {
    const other = group({
      groupId: "group-2",
      name: "Side project",
      threadId: "group-thread-2",
      members: [member("bot-grace", 0, { groupId: "group-2", leftAt: "2026-09-19T09:05:00.000Z" })],
    });
    const rows = groupDeleteCandidates({ group: group(), groups: [group(), other], bots: plain });
    expect(rows[1]).toMatchObject({ name: "Grace", checked: true, reason: null });
  });

  it("never ticks a member whose bot has not loaded", () => {
    const rows = groupDeleteCandidates({ group: group(), groups: [group()], bots: [] });
    expect(rows.every((row) => !row.checked)).toBe(true);
    expect(rows[0]?.reason).toBe("Still loading");
  });
});

describe("groupDeleteSummary", () => {
  it("says the chats go with the bots", () => {
    expect(groupDeleteSummary(3)).toBe("Deletes the group and 3 bots with their chats.");
    expect(groupDeleteSummary(1)).toBe("Deletes the group and 1 bot with its chats.");
  });

  it("says the bots are kept when nothing is ticked", () => {
    expect(groupDeleteSummary(0)).toBe(
      "Deletes the group and its conversation. Every bot keeps its own chats.",
    );
  });
});
