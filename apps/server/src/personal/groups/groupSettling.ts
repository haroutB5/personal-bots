// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalGroupService.ts.
// Deciding that a member's turn has ended, relaying its words, and the sweep.
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  CommandId,
  PersonalGroupId,
  ThreadId,
  type OrchestrationSession,
} from "@t3tools/contracts";
import { classifyProviderError, providerWaitPause } from "../tasks/PersonalTaskService.ts";
import { GROUP_LIMIT_RESUME_BUSY_WAIT_MS, GROUP_RESUMED_NOTICE_TEXT } from "./groupLimitResumes.ts";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";
import {
  LEASE_MINUTES,
  briefMessageId,
  expiredNote,
  isoAt,
  minutesFrom,
  windowMsFor,
} from "./groupShared.ts";
import type { GroupCore } from "./groupCore.ts";
import type { GroupVotes } from "./groupVotes.ts";
import type { GroupTurns } from "./groupTurns.ts";
import type { GroupFinish } from "./groupFinish.ts";

export const makeGroupSettling = (
  core: GroupCore,
  votes: GroupVotes,
  turns: GroupTurns,
  finish: GroupFinish,
) => {
  const {
    activeMemberThreadIds,
    botName,
    dispatchOrLog,
    fail,
    leaseOwner,
    limitResumes,
    liveBots,
    messages,
    refreshCaches,
    relayDelta,
    reportedWaits,
    repository,
    requireGroup,
    snapshots,
    throttles,
    writeSystemRow,
  } = core;
  const { voteGate } = votes;
  const {
    abandonActive,
    clearActive,
    closeRoundOfDeletedGroup,
    endRound,
    interruptActiveTurn,
    pump,
    writeRound,
  } = turns;
  const { finalReplyText, finishTurn, handleThrottle } = finish;

  /** Decides whether the active member's turn has ended, from the projection. */
  const settleActive = Effect.fn("PersonalGroupService.settleActive")(function* (
    threadId: ThreadId,
  ) {
    const found = yield* repository.getRoundByActiveThread(threadId);
    if (Option.isNone(found)) {
      activeMemberThreadIds.delete(threadId);
      return;
    }
    let round = found.value;
    const group = yield* requireGroup(round.groupId);
    const shell = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.mapError((cause) => fail("Personal groups could not read a session.", cause)));
    if (Option.isNone(shell)) {
      // The member thread is gone (its bot was deleted mid-reply). Its session
      // can never settle, and waiting for it would hold the one group slot,
      // server-wide, until the round's deadline. Keep what was said and move on.
      yield* abandonActive(group, round);
      yield* writeRound(round, clearActive);
      return;
    }
    const session: OrchestrationSession | null | undefined = shell.value.session;
    if (session === null || session === undefined) {
      return;
    }
    if (session.status === "running") {
      if (round.activeTurnId === null && session.activeTurnId !== null) {
        round = yield* writeRound(round, { activeTurnId: session.activeTurnId });
      }
      const now = yield* DateTime.now;
      const wait = session.providerRetry;
      if (wait?.kind === "rate_limited" && wait.retryAt !== undefined) {
        reportedWaits.set(threadId, {
          retryAt: wait.retryAt,
          provider: wait.provider,
          reason: wait.reason,
        });
      }
      const pause = providerWaitPause(session.providerRetry, DateTime.toEpochMillis(now));
      if (pause !== null) {
        yield* handleThrottle(
          group,
          round,
          pause.retryAtMs,
          pause.retry.reason ?? "The provider is rate limited.",
          { provider: pause.retry.provider, reason: pause.retry.reason },
        );
      }
      return;
    }
    const observed = round.activeTurnId !== null;
    const anchor = yield* messages
      .getByMessageId({ messageId: briefMessageId(round.roundId, round.spoken.length) })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const fresh =
      Option.isSome(anchor) && Date.parse(session.updatedAt) >= Date.parse(anchor.value.createdAt);
    if (!observed && !fresh) {
      // A session state left over from an earlier turn on this member's chat.
      return;
    }
    switch (session.status) {
      case "ready": {
        const last = yield* finalReplyText(round, threadId);
        if ((!observed && last === undefined) || last?.isStreaming === true) {
          return;
        }
        yield* finishTurn(group, round, last?.text ?? "");
        return;
      }
      case "interrupted":
      case "stopped": {
        const last = yield* finalReplyText(round, threadId);
        yield* finishTurn(group, round, last?.text ?? "");
        return;
      }
      case "error": {
        const stale = DateTime.toEpochMillis(yield* DateTime.now) - 60_000;
        const remembered = reportedWaits.get(threadId);
        const limit =
          session.providerRetry?.kind === "rate_limited"
            ? session.providerRetry
            : remembered !== undefined && Date.parse(remembered.retryAt) > stale
              ? { ...remembered, kind: "rate_limited" as const }
              : undefined;
        const resetMs = limit?.retryAt === undefined ? Number.NaN : Date.parse(limit.retryAt);
        if (limit !== undefined || classifyProviderError(session.lastError) === "rate_limited") {
          yield* handleThrottle(
            group,
            round,
            Number.isFinite(resetMs) ? resetMs : null,
            session.lastError ?? "The provider is rate limited.",
            { provider: limit?.provider ?? session.providerName, reason: limit?.reason },
          );
          return;
        }
        const all = yield* liveBots();
        const name = round.activeBotId === null ? "A bot" : botName(all, round.activeBotId);
        yield* abandonActive(group, round);
        yield* writeSystemRow(
          group,
          round.roundId,
          "member-skipped",
          `${name} could not reply${session.lastError === null ? "" : `: ${session.lastError}`}`,
        );
        yield* writeRound(round, { ...clearActive, errorMessage: session.lastError });
        return;
      }
      default:
        return;
    }
  });

  const relayFromMember = Effect.fn("PersonalGroupService.relayFromMember")(function* (
    threadId: ThreadId,
    delta: string,
  ) {
    if (delta.length === 0) {
      return;
    }
    const found = yield* repository.getRoundByActiveThread(threadId);
    if (Option.isNone(found)) {
      return;
    }
    const round = found.value;
    if (round.activeMessageId === null || round.activeBotId === null) {
      return;
    }
    const group = yield* requireGroup(round.groupId);
    // The marker (speaker + seq) rides only on a reply's first chunk, so the
    // bot roster and the reserved message are read once per reply, not once
    // per streamed delta (8-14 relays per reply).
    const reserved =
      round.relayedChars > 0
        ? Option.none()
        : yield* repository.getMessageByMessageId(round.activeMessageId);
    const all = Option.isNone(reserved) ? [] : yield* liveBots();
    yield* relayDelta({
      group,
      messageId: round.activeMessageId,
      delta,
      offset: round.relayedChars,
      marker: Option.isNone(reserved)
        ? null
        : {
            groupId: group.groupId,
            seq: reserved.value.seq,
            roundId: round.roundId,
            speaker: {
              kind: "bot",
              botId: round.activeBotId,
              name: botName(all, round.activeBotId),
            },
            ...(round.activeMessageId.endsWith("-verdict")
              ? { phase: "verdict" as const }
              : round.verdictBotId
                ? { phase: "discussion" as const }
                : {}),
          },
    });
    yield* writeRound(round, { relayedChars: round.relayedChars + delta.length });
  });

  /**
   * A turn started on a group thread by something other than this service -
   * the developer view can do it, and a provider running on G would inject no
   * persona and speak for nobody. It is stopped as soon as it is seen.
   */
  const stopStrayTurn = Effect.fn("PersonalGroupService.stopStrayTurn")(function* (
    threadId: ThreadId,
  ) {
    const group = yield* repository.getGroupByThreadId(threadId);
    if (Option.isNone(group)) {
      return;
    }
    yield* dispatchOrLog("interrupt stray turn", {
      type: "thread.turn.interrupt",
      commandId: CommandId.make(`personal-group:stray:${NodeCrypto.randomUUID()}`),
      threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    yield* writeSystemRow(
      group.value,
      null,
      "stray-turn-stopped",
      "A turn was started directly on this group thread and was stopped. Talk to the group instead; nobody runs on the shared thread.",
    );
  });

  /**
   * Carries cut-off rounds on once the limit that cut them off has reset (the
   * group counterpart of the bot chat's auto-continue). Runs in the sweep,
   * under the lock, so it never interleaves with a relay or a stop.
   *
   * Skipped when the owner wrote in the group since the hit, the group was
   * deleted or archived, or another round has taken over. A hit resumes once:
   * the row is claimed before anything is reopened.
   */
  const resumeDueLimitHits = Effect.fn("PersonalGroupService.resumeDueLimitHits")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = isoAt(nowMs);
    const due = yield* limitResumes.listDue(nowIso);
    for (const row of due) {
      const skip = (reason: string) =>
        limitResumes.resolve(row.resumeId, "skipped", reason, nowIso).pipe(
          Effect.andThen(
            Effect.logInfo("personal group resume skipped", {
              groupId: row.groupId,
              resumeId: row.resumeId,
              reason,
            }),
          ),
        );
      const found = yield* repository.getGroup(PersonalGroupId.make(row.groupId));
      if (Option.isNone(found)) {
        yield* skip("deleted");
        continue;
      }
      const group = found.value;
      if (group.archivedAt !== null) {
        yield* skip("archived");
        continue;
      }
      if ((yield* limitResumes.latestOwnerMessageAt(row.groupId)) > row.hitAt) {
        yield* skip("new_message");
        continue;
      }
      const latest = yield* repository.latestRoundForGroup(group.groupId);
      if (Option.isNone(latest) || latest.value.roundId !== row.roundId) {
        yield* skip("superseded");
        continue;
      }
      const round = latest.value;
      if (
        PersonalGroupRepository.PERSONAL_GROUP_LIVE_ROUND_STATUSES.some(
          (status) => status === round.status,
        )
      ) {
        // Still talking (or waiting on the owner): try again on the next sweep.
        if (nowMs - Date.parse(row.resumeAt) > GROUP_LIMIT_RESUME_BUSY_WAIT_MS) {
          yield* skip("busy");
        }
        continue;
      }
      const members = yield* repository.listMembers(group.groupId);
      const all = yield* liveBots();
      const targets = members.filter(
        (member) =>
          row.botIds.includes(member.botId) && all.some((bot) => bot.botId === member.botId),
      );
      if (targets.length === 0) {
        yield* skip("no_members");
        continue;
      }
      // Claimed before anything is reopened: whatever goes wrong next, this hit
      // never resumes a second time.
      if (!(yield* limitResumes.resolve(row.resumeId, "resumed", null, nowIso))) continue;

      const botIds = targets.map((member) => member.botId);
      if (row.kind === "members") {
        // A cut-off member's cursor moved when its turn started. Rewinding it
        // to the question means its brief replays what the group has said
        // since, instead of an empty catch-up.
        const trigger = yield* repository.getMessageByMessageId(round.triggerMessageId);
        if (Option.isSome(trigger)) {
          for (const target of targets) {
            const rewound = trigger.value.seq - 1;
            if (target.deliveredSeq > rewound) {
              yield* repository.writeMember({ ...target, deliveredSeq: rewound });
            }
          }
        }
      }
      for (const botId of botIds) throttles.delete(`${round.roundId}:${botId}`);
      const verdict = row.kind === "verdict";
      yield* writeRound(round, {
        ...clearActive,
        status: "running",
        queue: verdict ? [] : botIds,
        verdictBotId: verdict ? botIds[0]! : null,
        budgetRemaining: Math.max(round.budgetRemaining, botIds.length + 1),
        deadlineAt: DateTime.add(now, {
          milliseconds: windowMsFor(botIds.length + (verdict ? 1 : 0)),
        }),
        availableAt: null,
        errorMessage: null,
      });
      yield* writeSystemRow(
        group,
        round.roundId,
        "round-resumed",
        `${GROUP_RESUMED_NOTICE_TEXT}: ${targets
          .map((member) => botName(all, member.botId))
          .join(", ")} ${targets.length > 1 ? "continue" : "continues"}.`,
      );
      yield* Effect.logInfo("personal group resumed after a provider limit", {
        groupId: row.groupId,
        roundId: row.roundId,
        resumeId: row.resumeId,
        kind: row.kind,
        botIds: botIds.join(","),
        resumeAt: row.resumeAt,
      });
    }
  });

  const sweepOnce = Effect.fn("PersonalGroupService.sweepOnce")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    yield* repository.heartbeat({
      leaseOwner,
      now,
      leaseExpiresAt: minutesFrom(now, LEASE_MINUTES),
    });
    yield* refreshCaches();
    for (const round of yield* repository.listLiveRounds()) {
      if (round.status === "waiting_provider") {
        if (round.availableAt === null || DateTime.toEpochMillis(round.availableAt) <= nowMs) {
          yield* writeRound(round, { status: "running", availableAt: null });
        }
        continue;
      }
      const group = yield* repository.getGroup(round.groupId);
      if (Option.isNone(group)) {
        yield* closeRoundOfDeletedGroup(round);
        continue;
      }
      const expiredLease =
        round.activeBotId !== null &&
        round.leaseOwner !== leaseOwner &&
        (round.leaseExpiresAt === null || DateTime.toEpochMillis(round.leaseExpiresAt) < nowMs);
      if (expiredLease) {
        // The process that was relaying died. The round is NOT re-run on its
        // own: re-running a turn we could not watch could repeat its side
        // effects, so it waits for the user to press Continue (§2.6).
        const all = yield* liveBots();
        const name = round.activeBotId === null ? "a bot" : botName(all, round.activeBotId);
        yield* abandonActive(group.value, round);
        yield* writeSystemRow(
          group.value,
          round.roundId,
          "round-interrupted",
          `The server restarted while ${name} was replying.`,
        );
        yield* writeRound(round, {
          ...clearActive,
          status: "interrupted",
          // Continue resumes with this member; nothing re-queues it by itself.
          queue: round.activeBotId === null ? round.queue : [round.activeBotId, ...round.queue],
          budgetRemaining: round.budgetRemaining + 1,
        });
        continue;
      }
      if (nowMs >= DateTime.toEpochMillis(round.deadlineAt)) {
        if (round.activeBotId !== null) {
          yield* interruptActiveTurn(round, "wall-clock");
          yield* abandonActive(group.value, round);
        }
        const gate = yield* voteGate(round.roundId);
        if (gate.open !== null || gate.decided !== null) {
          // Time is up for the talking, not for the vote: the ballots that
          // never arrived are abstentions, and `pump` (through `nextStep`)
          // resolves the vote and parks the round for the owner (§V.2, §V.3).
          yield* writeRound(round, clearActive);
          continue;
        }
        yield* endRound(group.value, round, "interrupted", {
          event: "round-interrupted",
          text: expiredNote(round),
        });
        continue;
      }
      if (round.activeThreadId !== null) {
        yield* settleActive(round.activeThreadId);
      }
    }
    yield* resumeDueLimitHits().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("personal group limit resumes failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
    yield* pump;
  });

  return { relayFromMember, settleActive, stopStrayTurn, sweepOnce };
};

export type GroupSettling = ReturnType<typeof makeGroupSettling>;
