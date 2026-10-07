// Unparking, stopping, and what a deleted bot leaves behind.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";
import { type GroupRecord, type WorkItem, budgetFor, windowMsFor } from "./groupShared.ts";
import type { GroupCore } from "./groupCore.ts";
import type { GroupVotes } from "./groupVotes.ts";
import type { GroupTurns } from "./groupTurns.ts";
import type { GroupVoting } from "./groupVoting.ts";
import type { PersonalGroupService } from "./PersonalGroupService.ts";

export const makeGroupControl = (
  core: GroupCore,
  votes: GroupVotes,
  turns: GroupTurns,
  voting: GroupVoting,
  glue: { readonly worker: { readonly enqueue: (item: WorkItem) => Effect.Effect<void> } },
) => {
  const {
    botName,
    fail,
    liveBots,
    lock,
    publishGroup,
    repository,
    requireGroup,
    toPublic,
    toRound,
    writeSystemRow,
  } = core;
  const { expirePendingVotes } = votes;
  const { abandonActive, clearActive, interruptActiveTurn, writeRound } = turns;
  const { answerVote } = voting;
  const { worker } = glue;

  const continueRound: PersonalGroupService["Service"]["continueRound"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const latest = yield* repository.latestRoundForGroup(input.groupId);
          if (Option.isNone(latest)) {
            return yield* fail("This group has nothing to continue.");
          }
          const round = latest.value;
          if (input.vote !== undefined) {
            return yield* answerVote(group, round, input.vote);
          }
          if (round.status === "paused_vote") {
            return yield* fail(
              "This round is waiting for you to approve or reject a vote; answer that first.",
            );
          }
          if (round.status === "running") {
            return toRound(round);
          }
          if (
            round.status !== "paused_budget" &&
            round.status !== "waiting_provider" &&
            round.status !== "interrupted"
          ) {
            return yield* fail(`This round is ${round.status}; it cannot be continued.`);
          }
          if (round.queue.length === 0) {
            return toRound(yield* writeRound(round, { status: "completed", ...clearActive }));
          }
          const now = yield* DateTime.now;
          const members = yield* repository.listMembers(group.groupId);
          const resumed = yield* writeRound(round, {
            status: "running",
            // A fresh budget, deliberately: Continue is the user saying the
            // conversation is worth another round's worth of replies. It is
            // the same number the round opened with - the frozen rail for a
            // round aimed at named members, the group-sized one for a
            // broadcast, which is still carrying its reserved verdict turn.
            budgetRemaining: budgetFor({
              frozenMaxBotTurns: group.maxBotTurns,
              memberCount: members.length,
              broadcast: round.verdictBotId !== null,
            }),
            deadlineAt: DateTime.add(now, {
              milliseconds: windowMsFor(round.queue.length + (round.verdictBotId === null ? 0 : 1)),
            }),
            availableAt: null,
            errorMessage: null,
            ...clearActive,
          });
          yield* worker.enqueue({ type: "pump" });
          return toRound(resumed);
        }),
      )
      .pipe(toPublic("continueRound"));

  const stop: PersonalGroupService["Service"]["stop"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const latest = yield* repository.latestRoundForGroup(input.groupId);
          if (Option.isNone(latest)) {
            return;
          }
          const round = latest.value;
          const isLive = PersonalGroupRepository.PERSONAL_GROUP_LIVE_ROUND_STATUSES.some(
            (status) => status === round.status,
          );
          if (!isLive) {
            return;
          }
          // Stop stops everyone: the queue goes, and the one live member turn
          // is interrupted by its own thread and turn id, never by name.
          yield* interruptActiveTurn(round, "stop");
          yield* abandonActive(group, round);
          yield* expirePendingVotes(round);
          yield* writeSystemRow(group, round.roundId, "round-stopped", "You stopped the group.");
          yield* writeRound(round, { status: "stopped", queue: [], ...clearActive });
        }),
      )
      .pipe(toPublic("stop"));

  const groupNameForMemberThread: PersonalGroupService["Service"]["groupNameForMemberThread"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const member = yield* repository.getMemberByThreadId(threadId);
      if (Option.isNone(member)) {
        return Option.none<string>();
      }
      const group = yield* repository.getGroup(member.value.groupId);
      return Option.map(group, (entry) => entry.name);
    }).pipe(Effect.orElseSucceed(() => Option.none<string>()));

  const purgeBot: PersonalGroupService["Service"]["purgeBot"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const all = yield* liveBots();
          const name = botName(all, input.botId);
          const memberships = yield* repository.listMembershipsByBot(input.botId);
          for (const membership of memberships) {
            const group = yield* repository.getGroup(membership.groupId);
            if (Option.isNone(group)) {
              continue;
            }
            // A round the bot is speaking in, or queued for, moves on without
            // it now. Its thread is deleted next, and a turn on a deleted
            // thread never settles: the one group slot would stay held until
            // the round's deadline.
            for (const round of yield* repository.listLiveRounds()) {
              if (round.groupId !== membership.groupId) continue;
              const speaking = round.activeBotId === input.botId;
              if (!speaking && !round.queue.includes(input.botId)) continue;
              if (speaking) {
                yield* interruptActiveTurn(round, "bot-deleted");
                yield* abandonActive(group.value, round);
              }
              yield* writeRound(round, {
                ...(speaking ? clearActive : {}),
                queue: round.queue.filter((botId) => botId !== input.botId),
              });
            }
            yield* repository.removeMember({
              groupId: membership.groupId,
              botId: input.botId,
            });
            yield* writeSystemRow(
              group.value,
              null,
              "member-removed",
              `${name} was deleted, so it left this group.`,
            );
            const remaining = yield* repository.listMembers(membership.groupId);
            if (remaining.length === 0 && group.value.archivedAt === null) {
              const now = yield* DateTime.now;
              const archived: GroupRecord = { ...group.value, archivedAt: now, updatedAt: now };
              yield* repository.writeGroup(archived);
              yield* publishGroup(archived);
              continue;
            }
            yield* publishGroup(group.value);
          }
          // A round that just lost its speaker has a free slot to fill.
          yield* worker.enqueue({ type: "pump" });
        }),
      )
      .pipe(toPublic("purgeBot"));

  return { continueRound, groupNameForMemberThread, purgeBot, stop };
};

export type GroupControl = ReturnType<typeof makeGroupControl>;
