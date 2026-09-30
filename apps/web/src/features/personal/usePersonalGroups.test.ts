import { PersonalGroup, PersonalGroupRound, PersonalGroupVote } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PERSONAL_GROUPS_FEED,
  foldPersonalGroupsFeed,
  mergePersonalGroups,
  personalGroupsSettled,
} from "./usePersonalGroups";

const decodeGroup = Schema.decodeUnknownSync(PersonalGroup);
const decodeRound = Schema.decodeUnknownSync(PersonalGroupRound);
const decodeVote = Schema.decodeUnknownSync(PersonalGroupVote);

const group = (overrides: Record<string, unknown> = {}) =>
  decodeGroup({
    groupId: "group-1",
    name: "Launch crew",
    description: "",
    threadId: "group-thread-1",
    maxBotTurns: 6,
    members: [],
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-19T09:00:00.000Z",
    archivedAt: null,
    ...overrides,
  });

const round = (overrides: Record<string, unknown> = {}) =>
  decodeRound({
    roundId: "round-1",
    groupId: "group-1",
    triggerMessageId: "message-1",
    status: "paused_vote",
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

const vote = (overrides: Record<string, unknown> = {}) =>
  decodeVote({
    voteId: "vote-1",
    groupId: "group-1",
    roundId: "round-1",
    calledByBotId: "bot-ada",
    question: "Ship on Friday?",
    questionNormalised: "friday ship",
    options: ["ship", "wait"],
    status: "decided",
    winningOption: "ship",
    ballots: [],
    createdAt: "2026-09-19T09:04:00.000Z",
    decidedAt: "2026-09-19T09:06:00.000Z",
    ...overrides,
  });

describe("foldPersonalGroupsFeed", () => {
  it("keeps votes by vote id, so one round can settle more than one question", () => {
    const state = foldPersonalGroupsFeed(EMPTY_PERSONAL_GROUPS_FEED, [
      { type: "vote", vote: vote() },
      { type: "vote", vote: vote({ voteId: "vote-2", question: "Which database?" }) },
    ]);

    expect([...state.votes.keys()]).toEqual(["vote-1", "vote-2"]);
    expect(state.votes.get("vote-2")?.question).toBe("Which database?");
  });

  it("replaces a vote as it changes state, so an answered tally stops being one", () => {
    const open = foldPersonalGroupsFeed(EMPTY_PERSONAL_GROUPS_FEED, [
      { type: "vote", vote: vote() },
    ]);
    const answered = foldPersonalGroupsFeed(open, [
      { type: "vote", vote: vote({ status: "approved" }) },
    ]);

    expect(answered.votes.size).toBe(1);
    // The card keys off "decided", so this is what makes it disappear the
    // moment the owner has answered rather than on the next list refresh.
    expect(answered.votes.get("vote-1")?.status).toBe("approved");
  });

  it("still folds groups and rounds, one live round per group", () => {
    const state = foldPersonalGroupsFeed(EMPTY_PERSONAL_GROUPS_FEED, [
      { type: "group", group: group() },
      { type: "round", round: round() },
      { type: "round", round: round({ roundId: "round-2", status: "running" }) },
    ]);

    expect([...state.groups.keys()]).toEqual(["group-1"]);
    expect(state.rounds.get("group-1")?.roundId).toBe("round-2");
  });
});

describe("mergePersonalGroups", () => {
  it("shows the list's votes before any subscription exists", () => {
    const merged = mergePersonalGroups(
      { groups: [group()], rounds: [round()], votes: [vote()] },
      null,
    );

    expect(merged.votes.map((entry) => entry.voteId)).toEqual(["vote-1"]);
  });

  it("lets the feed win over the list for the same vote", () => {
    const merged = mergePersonalGroups(
      { groups: [group()], rounds: [round()], votes: [vote({ status: "decided" })] },
      foldPersonalGroupsFeed(EMPTY_PERSONAL_GROUPS_FEED, [
        { type: "vote", vote: vote({ status: "rejected" }) },
      ]),
    );

    expect(merged.votes.map((entry) => entry.status)).toEqual(["rejected"]);
  });

  it("keeps archived groups apart instead of dropping them", () => {
    const archivedAt = "2026-09-30T08:00:00.000Z";
    const merged = mergePersonalGroups(
      { groups: [group(), group({ groupId: "group-2", archivedAt })], rounds: [] },
      null,
    );
    expect(merged.groups.map((entry) => entry.groupId)).toEqual(["group-1"]);
    expect(merged.archivedGroups.map((entry) => entry.groupId)).toEqual(["group-2"]);
  });

  it("moves a group back to the open list when the feed unarchives it", () => {
    const archivedAt = "2026-09-30T08:00:00.000Z";
    const merged = mergePersonalGroups(
      { groups: [group({ archivedAt })], rounds: [] },
      foldPersonalGroupsFeed(EMPTY_PERSONAL_GROUPS_FEED, [
        { type: "group", group: group({ archivedAt: null }) },
      ]),
    );
    expect(merged.groups.map((entry) => entry.groupId)).toEqual(["group-1"]);
    expect(merged.archivedGroups).toEqual([]);
  });

  it("survives a list that predates votes entirely", () => {
    // `votes` is optional on the input: a cached list response from before this
    // feature simply has none, and must not throw on the way to the screen.
    const merged = mergePersonalGroups({ groups: [group()], rounds: [round()] }, null);
    expect(merged.votes).toEqual([]);
  });
});

describe("personalGroupsSettled", () => {
  it("is not settled before the list or the feed answers", () => {
    expect(personalGroupsSettled({ listData: null, listError: null, feed: null })).toBe(false);
  });

  it("settles on the list, the feed, or a failed list", () => {
    expect(personalGroupsSettled({ listData: { groups: [] }, listError: null, feed: null })).toBe(
      true,
    );
    expect(personalGroupsSettled({ listData: null, listError: null, feed: {} })).toBe(true);
    expect(personalGroupsSettled({ listData: null, listError: "offline", feed: null })).toBe(true);
  });
});
