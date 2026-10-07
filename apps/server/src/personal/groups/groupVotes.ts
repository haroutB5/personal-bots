// Votes inside a round: the gate, expiry and resolving a tally into an approval card.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  PersonalGroupRoundId,
  type PersonalBot,
  type PersonalBotId,
  type PersonalGroupMember,
  type PersonalGroupVote,
} from "@t3tools/contracts";
import { parseMentions } from "./groupMentions.ts";
import { tallyVote } from "./groupVotePolicy.ts";
import { type GroupRecord, type RoundRecord } from "./groupShared.ts";
import type { GroupCore } from "./groupCore.ts";

export const makeGroupVotes = (core: GroupCore) => {
  const { botName, publishVote, repository, writeSystemRow } = core;

  /**
   * What is stopping this round from closing. `open` is still taking ballots;
   * `decided` is a tally waiting for the owner, and nothing - not an empty
   * queue, not the wall clock - may throw that away, because approving it is
   * the only thing that can turn a bot majority into work (§V.3).
   */
  const voteGate = Effect.fn("PersonalGroupService.voteGate")(function* (
    roundId: PersonalGroupRoundId,
  ) {
    const pending = yield* repository.listPendingVotes(roundId);
    return {
      open: pending.find((vote) => vote.status === "open") ?? null,
      decided: pending.find((vote) => vote.status === "decided") ?? null,
    };
  });

  /** A round that truly ended takes its unanswered votes with it. */
  const expirePendingVotes = Effect.fn("PersonalGroupService.expirePendingVotes")(function* (
    round: RoundRecord,
  ) {
    const now = yield* DateTime.now;
    for (const vote of yield* repository.listPendingVotes(round.roundId)) {
      const expired: PersonalGroupVote = {
        ...vote,
        status: "expired",
        decidedAt: vote.decidedAt ?? now,
      };
      yield* repository.writeVote(expired);
      yield* publishVote(expired);
    }
  });

  /**
   * Counts the ballots and parks the result. Plurality wins; an exact tie, and
   * a vote nobody answered, resolve with no winner. Members that never
   * balloted are abstentions - counted and said out loud, rather than silently
   * read as agreement.
   *
   * This starts nothing. The tally lands in the transcript and the round
   * waits: these bots hold the shared browser, the saved logins and a shell,
   * so the owner is the only thing that turns a decision into an act.
   */
  const resolveVote = Effect.fn("PersonalGroupService.resolveVote")(function* (
    group: GroupRecord,
    round: RoundRecord,
    vote: PersonalGroupVote,
  ) {
    const members = yield* repository.listMembers(group.groupId);
    const tally = tallyVote({
      options: vote.options,
      ballots: vote.ballots,
      eligible: members.map((member) => member.botId),
    });
    const now = yield* DateTime.now;
    const decided: PersonalGroupVote = {
      ...vote,
      status: "decided",
      winningOption: tally.winningOption,
      decidedAt: now,
    };
    yield* repository.writeVote(decided);
    yield* publishVote(decided);
    const counts = tally.counts.map((entry) => `${entry.option} ${String(entry.votes)}`).join(", ");
    const abstained = tally.abstentions === 0 ? "" : `, ${String(tally.abstentions)} did not vote`;
    yield* writeSystemRow(
      group,
      round.roundId,
      "vote-resolved",
      tally.winningOption === null
        ? `The vote on "${vote.question}" is tied (${counts}${abstained}). Nothing happens until you answer it.`
        : `The vote on "${vote.question}" chose "${tally.winningOption}" (${counts}${abstained}). Nothing happens until you approve it.`,
    );
    return decided;
  });

  /**
   * The member an approved option becomes an instruction for. The option's own
   * text wins when it names a member, because "@Dev ships it" says who; the
   * bot that called the vote is the fallback, because it is the one that asked.
   */
  const approvalTarget = (
    vote: PersonalGroupVote,
    winningOption: string,
    members: ReadonlyArray<PersonalGroupMember>,
    all: ReadonlyArray<PersonalBot>,
  ): PersonalBotId | null => {
    const named = parseMentions(
      winningOption,
      members.map((member) => ({ botId: member.botId, name: botName(all, member.botId) })),
    ).find((botId) => members.some((member) => member.botId === botId));
    if (named !== undefined) {
      return named;
    }
    if (members.some((member) => member.botId === vote.calledByBotId)) {
      return vote.calledByBotId;
    }
    return members[0]?.botId ?? null;
  };

  // ---------------------------------------------------------------------
  // The round loop
  // ---------------------------------------------------------------------

  return { approvalTarget, expirePendingVotes, resolveVote, voteGate };
};

export type GroupVotes = ReturnType<typeof makeGroupVotes>;
