// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalGroupService.ts.
// Calling and casting a vote, and answering a resolved one.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
  PERSONAL_GROUP_VOTE_MAX_OPTIONS,
  PERSONAL_GROUP_VOTE_MIN_OPTIONS,
  PersonalGroupVoteId,
  type PersonalGroupVote,
  type PersonalGroupVoteBallot,
} from "@t3tools/contracts";
import { admitMentions } from "./groupRoundPolicy.ts";
import { normaliseQuestion } from "./groupVotePolicy.ts";
import { type GroupRecord, type RoundRecord, type WorkItem, windowMsFor } from "./groupShared.ts";
import type { GroupCore } from "./groupCore.ts";
import type { GroupVotes } from "./groupVotes.ts";
import type { GroupTurns } from "./groupTurns.ts";
import type { GroupMessaging } from "./groupMessaging.ts";
import type { PersonalGroupService } from "./PersonalGroupService.ts";

export const makeGroupVoting = (
  core: GroupCore,
  votes: GroupVotes,
  turns: GroupTurns,
  messaging: GroupMessaging,
  glue: { readonly worker: { readonly enqueue: (item: WorkItem) => Effect.Effect<void> } },
) => {
  const {
    botName,
    fail,
    liveBots,
    lock,
    publishVote,
    repository,
    toPublic,
    toRound,
    writeSystemRow,
  } = core;
  const { approvalTarget, resolveVote } = votes;
  const { clearActive, writeRound } = turns;
  const { requireSpeakingMember } = messaging;
  const { worker } = glue;

  const callVote: PersonalGroupService["Service"]["callVote"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const { round, group, members, botId } = yield* requireSpeakingMember(
            input.threadId,
            "vote on",
          );
          const question = input.question.trim();
          if (question.length === 0) {
            return yield* fail("A vote needs a question.");
          }
          const options = [
            ...new Set(input.options.map((option) => option.trim()).filter((o) => o.length > 0)),
          ];
          if (options.length < PERSONAL_GROUP_VOTE_MIN_OPTIONS) {
            return yield* fail(
              `A vote needs at least ${String(PERSONAL_GROUP_VOTE_MIN_OPTIONS)} different options.`,
            );
          }
          if (options.length > PERSONAL_GROUP_VOTE_MAX_OPTIONS) {
            return yield* fail(
              `A vote can offer at most ${String(PERSONAL_GROUP_VOTE_MAX_OPTIONS)} options.`,
            );
          }

          const existing = yield* repository.listVotesForRound(round.roundId);
          const open = existing.find((vote) => vote.status === "open");
          if (open !== undefined) {
            // One open vote per round: two ballots running at once would make
            // "everyone has voted" mean nothing and let a second question
            // reopen a first one sideways.
            return yield* fail(
              `A vote is already open in this group: ${open.voteId} "${open.question}". Cast your ballot on that one with cast_vote instead.`,
            );
          }
          const questionNormalised = normaliseQuestion(question);
          const settled = existing.find((vote) => vote.questionNormalised === questionNormalised);
          if (settled !== undefined) {
            // Matched on the normalised question, so rewording it does not buy
            // a second vote: a losing side cannot simply ask again.
            return yield* fail(
              `This round already voted on that: "${settled.question}" (${settled.winningOption ?? "tied"}). Ask a different question, or let the user answer the tally.`,
            );
          }

          const now = yield* DateTime.now;
          const all = yield* liveBots();
          const vote: PersonalGroupVote = {
            voteId: PersonalGroupVoteId.make(
              `vote-${NodeCrypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
            ),
            groupId: group.groupId,
            roundId: round.roundId,
            calledByBotId: botId,
            question,
            questionNormalised,
            options,
            status: "open",
            winningOption: null,
            ballots: [],
            createdAt: now,
            decidedAt: null,
          };
          yield* repository.insertVote(vote);

          // The other members are queued so each one gets a turn in which to
          // ballot - through `admitMentions`, so the per-member cap and the
          // membership check are the same ones a mention goes through.
          //
          // The caller gets no extra turn for having called the vote (section
          // V.2): it may vote in the turn it already holds. `admitMentions` is
          // what enforces that, by dropping a speaker that names itself; the
          // filter below only says so at the call site. Mutation-checked, and
          // recorded: removing the filter changes nothing, because the policy
          // still refuses. Both stay, but the policy is the one that bites.
          const others = members.map((member) => member.botId).filter((entry) => entry !== botId);
          const admitted = admitMentions({
            speaker: botId,
            mentioned: others,
            queue: round.queue,
            spoken: round.spoken,
            members: members.map((member) => member.botId),
            maxTurnsPerMember: PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
          });
          yield* writeRound(round, { queue: [...round.queue, ...admitted] });

          const voterNames = members.map((member) => botName(all, member.botId));
          yield* writeSystemRow(
            group,
            round.roundId,
            "vote-opened",
            `${botName(all, botId)} called a vote (${vote.voteId}): "${question}" - ${options
              .map((option) => `"${option}"`)
              .join(
                " or ",
              )}. Everyone answers with cast_vote; nothing happens until you approve the result.`,
          );
          yield* publishVote(vote);
          return { vote, voterNames };
        }),
      )
      .pipe(toPublic("callVote"));

  const castVote: PersonalGroupService["Service"]["castVote"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const { round, group, members, botId } = yield* requireSpeakingMember(
            input.threadId,
            "vote in",
          );
          const found = yield* repository.getVote(input.voteId);
          if (Option.isNone(found)) {
            return yield* fail(`There is no vote '${input.voteId}'.`);
          }
          const vote = found.value;
          if (vote.roundId !== round.roundId) {
            return yield* fail(`Vote '${input.voteId}' belongs to a different round.`);
          }
          if (vote.status !== "open") {
            return yield* fail(
              `Vote '${input.voteId}' is ${vote.status} and is not taking ballots any more.`,
            );
          }
          const wanted = input.option.trim().toLowerCase();
          const option = vote.options.find((entry) => entry.trim().toLowerCase() === wanted);
          if (option === undefined) {
            return yield* fail(
              `'${input.option}' is not on this ballot. Choose one of: ${vote.options.join(", ")}.`,
            );
          }
          const now = yield* DateTime.now;
          const ballot: PersonalGroupVoteBallot = {
            voteId: vote.voteId,
            botId,
            option,
            reason: input.reason.trim(),
            createdAt: now,
          };
          // One ballot per bot per vote, decided by the primary key: two
          // ballots racing cannot both land, and a second one changes nothing.
          const counted = yield* repository.insertBallot(ballot);
          if (!counted) {
            return yield* fail(
              `You have already voted in '${vote.voteId}'. A ballot is cast once and cannot be changed.`,
            );
          }
          const updated = yield* repository.getVote(vote.voteId);
          if (Option.isNone(updated)) {
            return yield* fail(`There is no vote '${input.voteId}'.`);
          }
          yield* publishVote(updated.value);
          const balloted = new Set(updated.value.ballots.map((entry) => entry.botId));
          if (members.every((member) => balloted.has(member.botId))) {
            return yield* resolveVote(group, round, updated.value);
          }
          return updated.value;
        }),
      )
      .pipe(toPublic("castVote"));

  /**
   * The owner's Approve / Reject of a resolved tally. Approve writes the
   * decision into the transcript - which is how it reaches the member, as the
   * next line of its catch-up brief - and puts that member at the front of the
   * queue; the ordinary pump starts the turn, so the reservation, the cursor
   * and the marker seq stay in one place.
   *
   * Approve grants no budget. "The round continues if budget remains" is
   * literal: a spent round parks on paused_budget with the instruction already
   * written, and Continue runs it.
   */
  const answerVote = Effect.fn("PersonalGroupService.answerVote")(function* (
    group: GroupRecord,
    round: RoundRecord,
    answer: { readonly voteId: PersonalGroupVoteId; readonly decision: "approve" | "reject" },
  ) {
    const found = yield* repository.getVote(answer.voteId);
    if (Option.isNone(found)) {
      return yield* fail(`There is no vote '${answer.voteId}'.`);
    }
    const vote = found.value;
    if (vote.groupId !== group.groupId) {
      return yield* fail(`Vote '${answer.voteId}' belongs to a different group.`);
    }
    if (vote.status !== "decided") {
      return yield* fail(
        `Vote '${answer.voteId}' is ${vote.status}; only a resolved vote can be approved or rejected.`,
      );
    }
    const members = yield* repository.listMembers(group.groupId);
    const all = yield* liveBots();
    const now = yield* DateTime.now;
    const fresh = {
      // The answer restarts the clock over the work still queued; approve adds
      // the target's turn to it, so one extra turn is counted here.
      deadlineAt: DateTime.add(now, {
        milliseconds: windowMsFor(round.queue.length + (round.verdictBotId === null ? 1 : 2)),
      }),
      availableAt: null,
      errorMessage: null,
      ...clearActive,
    } as const;

    if (answer.decision === "reject") {
      const rejected: PersonalGroupVote = { ...vote, status: "rejected" };
      yield* repository.writeVote(rejected);
      yield* publishVote(rejected);
      yield* writeSystemRow(
        group,
        round.roundId,
        "vote-rejected",
        `You rejected the vote on "${vote.question}". Carry on without it.`,
      );
      const resumed = yield* writeRound(round, { status: "running", ...fresh });
      yield* worker.enqueue({ type: "pump" });
      return toRound(resumed);
    }

    const winning = vote.winningOption;
    if (winning === null) {
      return yield* fail(
        `Vote '${answer.voteId}' is tied, so there is no winning option to approve. Reject it and let the group decide again.`,
      );
    }
    const target = approvalTarget(vote, winning, members, all);
    if (target === null) {
      return yield* fail("This group has no members left to carry out that decision.");
    }
    const approved: PersonalGroupVote = { ...vote, status: "approved" };
    yield* repository.writeVote(approved);
    yield* publishVote(approved);
    yield* writeSystemRow(
      group,
      round.roundId,
      "vote-approved",
      `You approved "${winning}". ${botName(all, target)}, that is the group's decision - do that next.`,
    );
    // The owner's instruction beats the per-member cap: the cap exists to stop
    // bots talking each other in circles, not to overrule the user.
    const resumed = yield* writeRound(round, {
      status: "running",
      queue: [target, ...round.queue.filter((entry) => entry !== target)],
      ...fresh,
    });
    yield* worker.enqueue({ type: "pump" });
    return toRound(resumed);
  });

  return { answerVote, callVote, castVote };
};

export type GroupVoting = ReturnType<typeof makeGroupVoting>;
