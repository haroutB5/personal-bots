// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalGroupService.ts.
// Running a round: starting a member's turn, ending a round and the pump that takes the next speaker.
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  CommandId,
  MessageId,
  PERSONAL_GROUP_CATCHUP_MAX_CHARS,
  PERSONAL_GROUP_CONCURRENCY,
  PersonalGroupsError,
  ThreadId,
  type PersonalBotId,
  type PersonalGroupRound,
  type PersonalGroupSystemEvent,
} from "@t3tools/contracts";
import { botModelSelectionForThread } from "../botModelSelection.ts";
import { groupExposureKey, threadExposureKey } from "../browser/sensitiveExposureStore.ts";
import { nextStep } from "./groupRoundPolicy.ts";
import { buildCatchUpBrief, type GroupCatchUpMessage } from "./groupTurnText.ts";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";
import {
  type GroupRecord,
  LEASE_MINUTES,
  type RoundRecord,
  briefMessageId,
  budgetFor,
  expiredNote,
  minutesFrom,
  personalGroupMessageContext,
  replyMessageId,
} from "./groupShared.ts";
import type { GroupCore } from "./groupCore.ts";
import type { GroupVotes } from "./groupVotes.ts";
import { loopEndedText, nextRound, pausedBudgetText } from "./groupSchedulePolicy.ts";

export const makeGroupTurns = (core: GroupCore, votes: GroupVotes) => {
  const {
    activeMemberThreadIds,
    botName,
    botRepository,
    bots,
    carryTaint,
    dispatchOrLog,
    engine,
    fail,
    leaseOwner,
    liveBots,
    publishRound,
    readMessageText,
    relayComplete,
    reportedWaits,
    repository,
    snapshots,
    writeSystemRow,
  } = core;
  const { expirePendingVotes, resolveVote, voteGate } = votes;

  const writeRound = Effect.fn("PersonalGroupService.writeRound")(function* (
    round: RoundRecord,
    patch: Partial<RoundRecord>,
  ) {
    const next: RoundRecord = { ...round, ...patch, updatedAt: yield* DateTime.now };
    yield* repository.writeRound(next);
    yield* publishRound(next);
    return next;
  });

  const clearActive = {
    activeBotId: null,
    activeThreadId: null,
    activeTurnId: null,
    activeMessageId: null,
    relayedChars: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
  } as const satisfies Partial<RoundRecord>;

  /**
   * Ends the active turn without a reply. A turn that relayed nothing leaves no
   * empty bubble behind - its reserved log row is dropped - while a partial
   * reply is completed so the user keeps what was already said.
   */
  const abandonActive = Effect.fn("PersonalGroupService.abandonActive")(function* (
    group: GroupRecord,
    round: RoundRecord,
  ) {
    if (round.activeThreadId !== null) {
      activeMemberThreadIds.delete(round.activeThreadId);
    }
    if (round.activeMessageId === null) {
      return;
    }
    if (round.relayedChars === 0) {
      yield* repository.deleteMessage(round.activeMessageId);
      return;
    }
    if (round.activeThreadId !== null) {
      yield* carryTaint([threadExposureKey(round.activeThreadId)], groupExposureKey(group.groupId));
    }
    yield* relayComplete({ group, messageId: round.activeMessageId });
  });

  const interruptActiveTurn = Effect.fn("PersonalGroupService.interruptActiveTurn")(function* (
    round: RoundRecord,
    reason: string,
  ) {
    if (round.activeThreadId === null) {
      return;
    }
    yield* dispatchOrLog("interrupt member turn", {
      type: "thread.turn.interrupt",
      commandId: CommandId.make(`personal-group:${round.roundId}:${reason}:interrupt`),
      threadId: round.activeThreadId,
      ...(round.activeTurnId !== null ? { turnId: round.activeTurnId } : {}),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  /** Starts the next member's turn. Returns whether a turn actually started. */
  const startMemberTurn = Effect.fn("PersonalGroupService.startMemberTurn")(function* (
    group: GroupRecord,
    round: RoundRecord,
    botId: PersonalBotId,
    finalVerdict = false,
  ) {
    const rest = round.queue.slice(1);
    const members = yield* repository.listMembers(group.groupId);
    const member = members.find((entry) => entry.botId === botId);
    const all = yield* liveBots();
    const bot = all.find((entry) => entry.botId === botId);
    if (member === undefined || bot === undefined) {
      // The member left, or its bot was deleted, between queueing and now.
      yield* writeRound(round, { queue: rest, ...(finalVerdict ? { verdictBotId: null } : {}) });
      return false;
    }
    const now = yield* DateTime.now;
    const threadId = member.threadId ?? ThreadId.make(NodeCrypto.randomUUID());
    reportedWaits.delete(threadId);
    yield* bots
      .createThread({ botId, threadId })
      .pipe(
        Effect.mapError((cause) => fail("Personal groups could not open a member chat.", cause)),
      );
    // The brief below hands this member everything the group has said.
    yield* carryTaint([groupExposureKey(group.groupId)], threadExposureKey(threadId));

    // Catch-up first, cursor second, reservation third: the speaker must not
    // be shown its own pending reply, whose seq is by construction the highest.
    const pending = yield* repository.listMessagesAfter({
      groupId: group.groupId,
      afterSeq: finalVerdict ? 0 : member.deliveredSeq,
    });
    const catchUp: Array<GroupCatchUpMessage> = [];
    for (const entry of pending) {
      if (finalVerdict && entry.roundId !== round.roundId) continue;
      const text = yield* readMessageText(entry.messageId);
      if (text.length === 0) continue;
      catchUp.push({
        speaker:
          entry.speakerKind === "user"
            ? "You"
            : entry.speakerKind === "system"
              ? "System"
              : entry.speakerBotId === null
                ? "A bot"
                : botName(all, entry.speakerBotId),
        text,
      });
    }
    const latestSeq = yield* repository.latestSeq(group.groupId);
    yield* repository.writeMember({ ...member, threadId, deliveredSeq: latestSeq });

    const turn = round.spoken.length + 1;
    const replyId = finalVerdict
      ? MessageId.make(`${replyMessageId(round.roundId, turn)}-verdict`)
      : replyMessageId(round.roundId, turn);
    const reserved = yield* repository.insertMessage({
      groupId: group.groupId,
      messageId: replyId,
      speakerKind: "bot",
      speakerBotId: botId,
      roundId: round.roundId,
      createdAt: now,
    });

    const brief = buildCatchUpBrief({
      ...(finalVerdict
        ? { phase: "verdict" as const }
        : round.verdictBotId
          ? { phase: "discussion" as const }
          : {}),
      ...(finalVerdict ? { userRequest: yield* readMessageText(round.triggerMessageId) } : {}),
      groupName: group.name,
      speakerName: bot.name,
      otherNames: members
        .filter((entry) => entry.botId !== botId)
        .map((entry) => botName(all, entry.botId)),
      messages: finalVerdict
        ? catchUp.map((entry) => {
            // Preserve a share of every contribution instead of truncating
            // whole early speakers out of the final synthesis.
            const limit = Math.max(
              100,
              Math.floor(PERSONAL_GROUP_CATCHUP_MAX_CHARS / Math.max(1, catchUp.length)) -
                entry.speaker.length -
                80,
            );
            return entry.text.length <= limit
              ? entry
              : {
                  ...entry,
                  text: `${entry.text.slice(0, limit)}\n[Contribution truncated; verify missing details before concluding.]`,
                };
          })
        : catchUp,
      maxChars: PERSONAL_GROUP_CATCHUP_MAX_CHARS,
    });

    const started = yield* writeRound(round, {
      ...(finalVerdict ? { verdictBotId: null } : {}),
      queue: rest,
      spoken: [...round.spoken, botId],
      budgetRemaining: Math.max(0, round.budgetRemaining - 1),
      activeBotId: botId,
      activeThreadId: threadId,
      activeTurnId: null,
      activeMessageId: replyId,
      relayedChars: 0,
      leaseOwner,
      leaseExpiresAt: minutesFrom(now, LEASE_MINUTES),
      availableAt: null,
    });
    activeMemberThreadIds.add(threadId);

    // The member's current model and options (reasoning effort above all); a
    // turn without them runs at the provider's defaults.
    const memberThread = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const modelSelection = yield* botModelSelectionForThread(
      botRepository,
      threadId,
      Option.isSome(memberThread) ? memberThread.value.modelSelection : undefined,
    );
    const dispatched = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`personal-group:${round.roundId}:${String(turn)}:turn.start`),
        threadId,
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        message: {
          messageId: briefMessageId(round.roundId, turn),
          role: "user",
          text: brief,
          attachments: [],
          context: personalGroupMessageContext({
            groupId: group.groupId,
            seq: latestSeq,
            roundId: round.roundId,
            speaker: { kind: "user" },
            relayedFromGroup: true,
          }),
        },
        titleSeed: group.name,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: DateTime.formatIso(now),
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("personal groups could not start a member turn", {
                groupId: group.groupId,
                botId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );
    if (!dispatched) {
      yield* repository.deleteMessage(reserved.messageId);
      yield* writeSystemRow(
        group,
        round.roundId,
        "member-skipped",
        `${bot.name} could not be started, so the group moved on.`,
      );
      yield* writeRound(started, { ...clearActive, budgetRemaining: started.budgetRemaining + 1 });
      activeMemberThreadIds.delete(threadId);
      return false;
    }
    return true;
  });

  const endRound = Effect.fn("PersonalGroupService.endRound")(function* (
    group: GroupRecord,
    round: RoundRecord,
    status: PersonalGroupRound["status"],
    note: { readonly event: PersonalGroupSystemEvent; readonly text: string } | null,
  ) {
    if (status !== "paused_budget" && status !== "paused_vote") {
      // completed, stopped, interrupted: nobody is coming back to answer an
      // open ballot, and a tally the owner can no longer act on is not a tally.
      yield* expirePendingVotes(round);
    }
    if (note !== null) {
      yield* writeSystemRow(group, round.roundId, note.event, note.text);
    }
    return yield* writeRound(round, {
      status,
      ...clearActive,
      // A parked round keeps its queue: Continue, and Approve, resume it.
      ...(status === "paused_budget" || status === "paused_vote" ? {} : { queue: [] }),
    });
  });

  /**
   * Ends a live round whose group has been deleted. There is no transcript
   * left to write a note into, so it only stops the member turn and frees the
   * slot; left alone, such a round would hold the one group slot or fail
   * every pump at the same row, across restarts.
   */
  const closeRoundOfDeletedGroup = Effect.fn("PersonalGroupService.closeRoundOfDeletedGroup")(
    function* (round: RoundRecord) {
      yield* interruptActiveTurn(round, "group-deleted");
      if (round.activeThreadId !== null) {
        activeMemberThreadIds.delete(round.activeThreadId);
      }
      if (round.activeMessageId !== null) {
        yield* repository.deleteMessage(round.activeMessageId);
      }
      yield* expirePendingVotes(round);
      return yield* writeRound(round, { status: "stopped", queue: [], ...clearActive });
    },
  );

  /** Fills the single group slot; one member speaks at a time, server-wide. */
  const pump: Effect.Effect<
    void,
    PersonalGroupsError | PersonalGroupRepository.PersonalGroupRepositoryError
  > = Effect.gen(function* () {
    while (true) {
      const live = yield* repository.listLiveRounds();
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      // PERSONAL_GROUP_CONCURRENCY = 1, and this slot is disjoint from the
      // task system's five (PERSONAL_TASKS_CONCURRENCY), so the worst case
      // stays six provider turns.
      const next = nextRound(
        live,
        (entry) => (entry.availableAt === null ? null : DateTime.toEpochMillis(entry.availableAt)),
        nowMs,
        PERSONAL_GROUP_CONCURRENCY,
      );
      if (next.kind !== "round") {
        return;
      }
      const round = next.round;
      const found = yield* repository.getGroup(round.groupId);
      if (Option.isNone(found)) {
        yield* closeRoundOfDeletedGroup(round);
        continue;
      }
      const group = found.value;
      const gate = yield* voteGate(round.roundId);
      const verdict = nextStep({
        queue: round.queue,
        spoken: round.spoken,
        budgetRemaining: round.budgetRemaining,
        nowMs,
        deadlineMs: DateTime.toEpochMillis(round.deadlineAt),
        openVote: gate.open !== null,
        decidedVoteAwaitingUser: gate.decided !== null,
      });
      switch (verdict.kind) {
        case "expired":
          yield* endRound(group, round, "interrupted", {
            event: "round-interrupted",
            text: expiredNote(round),
          });
          continue;
        case "completed":
          if (round.verdictBotId) {
            const members = yield* repository.listMembers(group.groupId);
            const selected =
              members.find((member) => member.botId === round.verdictBotId) ?? members[0];
            if (selected && round.spoken.length > 0) {
              // The synthesis is one reserved turn after the bounded discussion.
              const started = yield* startMemberTurn(
                group,
                { ...round, queue: [selected.botId] },
                selected.botId,
                true,
              );
              if (started) return;
              continue;
            }
          }
          yield* endRound(group, round, "completed", null);
          continue;
        case "ping-pong": {
          const all = yield* liveBots();
          const [first, second] = round.spoken.slice(-2);
          yield* endRound(group, round, "completed", {
            event: "round-ended-loop",
            text: loopEndedText(botName(all, second!), botName(all, first!)),
          });
          continue;
        }
        case "paused_vote":
          // The tally is written; the round stops here until the owner
          // answers it. No system row: resolveVote already said it, and
          // saying it twice would read as two separate events.
          yield* endRound(group, round, "paused_vote", null);
          continue;
        case "resolve_vote":
          // A dead end with ballots still out: the wall clock, or a queue that
          // ran dry before everyone voted. The missing ballots are
          // abstentions and the vote resolves rather than the round closing
          // over it (§V.2).
          yield* resolveVote(group, round, gate.open!);
          continue;
        case "paused_budget": {
          // The number the user is told is the budget this round was actually
          // granted, which for a broadcast is the group-sized one, not the
          // frozen `maxBotTurns`.
          const members = yield* repository.listMembers(group.groupId);
          const granted = budgetFor({
            frozenMaxBotTurns: group.maxBotTurns,
            memberCount: members.length,
            broadcast: round.verdictBotId !== null,
          });
          yield* endRound(group, round, "paused_budget", {
            event: "round-paused-budget",
            text: pausedBudgetText(granted),
          });
          continue;
        }
        case "speak": {
          const started = yield* startMemberTurn(group, round, verdict.botId);
          if (started) {
            return;
          }
          continue;
        }
      }
    }
  });

  return {
    abandonActive,
    clearActive,
    closeRoundOfDeletedGroup,
    endRound,
    interruptActiveTurn,
    pump,
    writeRound,
  };
};

export type GroupTurns = ReturnType<typeof makeGroupTurns>;
