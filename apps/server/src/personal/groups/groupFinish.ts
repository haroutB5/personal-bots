// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalGroupService.ts.
// Finishing a member's turn and what happens when a member's provider says no.
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
  ThreadId,
  type PersonalBotId,
} from "@t3tools/contracts";
import { groupExposureKey, threadExposureKey } from "../browser/sensitiveExposureStore.ts";
import { parseMentions } from "./groupMentions.ts";
import { decideLimitHit } from "../personalChatResumePolicy.ts";
import { groupPausedText, type GroupLimitResumeKind } from "./groupLimitResumes.ts";
import { admitMentions } from "./groupRoundPolicy.ts";
import {
  type GroupRecord,
  MAX_CONSECUTIVE_THROTTLES,
  type RoundRecord,
  UNREPORTED_THROTTLE_BACKOFF_MS,
  briefMessageId,
  isoAt,
  windowMsFor,
} from "./groupShared.ts";
import type { GroupCore } from "./groupCore.ts";
import type { GroupTurns } from "./groupTurns.ts";

export const makeGroupFinish = (core: GroupCore, turns: GroupTurns) => {
  const {
    activeMemberThreadIds,
    botName,
    carryTaint,
    limitResumes,
    liveBots,
    messages,
    relayComplete,
    relayDelta,
    reportedWaits,
    repository,
    throttles,
    writeSystemRow,
  } = core;
  const { abandonActive, clearActive, endRound, interruptActiveTurn, writeRound } = turns;

  /** The authoritative final text of the active turn, or undefined if unfinished. */
  const finalReplyText = Effect.fn("PersonalGroupService.finalReplyText")(function* (
    round: RoundRecord,
    threadId: ThreadId,
  ) {
    if (round.activeTurnId !== null) {
      const byTurn = yield* messages
        .getLatestAssistantMessageForTurn({ threadId, turnId: round.activeTurnId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(byTurn)) {
        return byTurn.value;
      }
    }
    const anchorId = briefMessageId(round.roundId, round.spoken.length);
    const anchor = yield* messages
      .getByMessageId({ messageId: anchorId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(anchor)) {
      return undefined;
    }
    const after = yield* messages
      .getLatestAssistantMessageAfter({
        threadId,
        afterCreatedAt: anchor.value.createdAt,
        afterMessageId: anchor.value.messageId,
      })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.getOrUndefined(after);
  });

  const finishTurn = Effect.fn("PersonalGroupService.finishTurn")(function* (
    group: GroupRecord,
    round: RoundRecord,
    finalText: string,
  ) {
    const botId = round.activeBotId;
    const messageId = round.activeMessageId;
    if (botId === null || messageId === null) {
      return;
    }
    if (round.activeThreadId !== null) {
      activeMemberThreadIds.delete(round.activeThreadId);
      // Whatever the member saw can be in what it just said to the group.
      yield* carryTaint([threadExposureKey(round.activeThreadId)], groupExposureKey(group.groupId));
    }
    throttles.delete(`${round.roundId}:${botId}`);
    if (round.activeThreadId !== null) reportedWaits.delete(round.activeThreadId);
    const all = yield* liveBots();
    const name = botName(all, botId);

    if (finalText.length === 0 && round.relayedChars === 0) {
      // Nothing was said: drop the reservation rather than leave an empty
      // bubble in the transcript, and tell the user why the member is silent.
      yield* repository.deleteMessage(messageId);
      yield* writeSystemRow(
        group,
        round.roundId,
        "member-skipped",
        `${name} replied with nothing.`,
      );
      yield* writeRound(round, clearActive);
      return;
    }

    const reserved = yield* repository.getMessageByMessageId(messageId);
    // The speaker's cursor moves past its OWN reply: it already has the text
    // in its own thread, so relaying it back as catch-up would be the same
    // words twice and charge the session for them.
    if (Option.isSome(reserved)) {
      const own = yield* repository.listMembers(group.groupId);
      const speaker = own.find((member) => member.botId === botId);
      if (speaker !== undefined && speaker.deliveredSeq < reserved.value.seq) {
        yield* repository.writeMember({ ...speaker, deliveredSeq: reserved.value.seq });
      }
    }
    if (finalText.length > round.relayedChars) {
      yield* relayDelta({
        group,
        messageId,
        delta: finalText.slice(round.relayedChars),
        offset: round.relayedChars,
        marker:
          round.relayedChars > 0 || Option.isNone(reserved)
            ? null
            : {
                groupId: group.groupId,
                seq: reserved.value.seq,
                roundId: round.roundId,
                speaker: { kind: "bot", botId, name },
                ...(messageId.endsWith("-verdict")
                  ? { phase: "verdict" as const }
                  : round.verdictBotId
                    ? { phase: "discussion" as const }
                    : {}),
              },
      });
    }
    yield* relayComplete({ group, messageId });

    if (messageId.endsWith("-verdict")) {
      yield* writeRound(round, { ...clearActive, queue: [] });
      return;
    }
    if (round.verdictBotId) {
      yield* writeRound(round, clearActive);
      return;
    }

    const members = yield* repository.listMembers(group.groupId);
    const mentioned = parseMentions(
      finalText,
      members.map((member) => ({ botId: member.botId, name: botName(all, member.botId) })),
    );
    const admitted = admitMentions({
      speaker: botId,
      mentioned,
      queue: round.queue,
      spoken: round.spoken,
      members: members.map((member) => member.botId),
      maxTurnsPerMember: PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
    });
    yield* writeRound(round, { ...clearActive, queue: [...round.queue, ...admitted] });
  });

  interface LimitOrigin {
    readonly provider: string | null | undefined;
    readonly reason: string | undefined;
  }

  interface LimitPlan {
    readonly decision: ReturnType<typeof decideLimitHit>;
    readonly nowMs: number;
  }

  /**
   * Whether a cut-off member can be carried on after the reset it reported.
   * Null without a reported reset: the round's own handling is all there is.
   */
  const planLimitHit = (
    group: GroupRecord,
    retryAtMs: number | null,
  ): Effect.Effect<LimitPlan | null> =>
    retryAtMs === null
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
          const lastOwner = yield* limitResumes.latestOwnerMessageAt(group.groupId);
          const consecutiveResumes = yield* limitResumes.countResumedSince(
            group.groupId,
            lastOwner,
          );
          return {
            decision: decideLimitHit({
              retry: { retryAt: isoAt(retryAtMs) },
              nowMs,
              consecutiveResumes,
            }),
            nowMs,
          } satisfies LimitPlan;
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("personal group could not plan a limit resume", {
                  groupId: group.groupId,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
          ),
        );

  /** Books the resume for a planned hit and says so in the transcript. */
  const commitLimitHit = (
    group: GroupRecord,
    round: RoundRecord,
    kind: GroupLimitResumeKind,
    botId: PersonalBotId,
    plan: LimitPlan | null,
    origin: LimitOrigin,
  ) =>
    Effect.gen(function* () {
      if (plan === null) return;
      const { decision, nowMs } = plan;
      // A reset too far out is not believed: the round's own handling only.
      if (decision.kind === "notice_only" && decision.reason !== "too_many_resumes") return;
      const all = yield* liveBots();
      const name = botName(all, botId);
      if (decision.kind === "schedule") {
        yield* limitResumes.schedule({
          resumeId: NodeCrypto.randomUUID(),
          groupId: group.groupId,
          roundId: round.roundId,
          kind,
          botId,
          provider: origin.provider ?? "unknown",
          reason: origin.reason ?? null,
          hitAt: isoAt(nowMs),
          resumeAt: isoAt(decision.resumeAtMs),
        });
      }
      yield* writeSystemRow(
        group,
        round.roundId,
        "member-paused",
        groupPausedText({
          provider: origin.provider,
          reason: origin.reason,
          names: [name],
          decision,
          nowMs,
        }),
      );
      yield* Effect.logInfo("personal group member paused on a provider limit", {
        groupId: group.groupId,
        roundId: round.roundId,
        botId,
        kind,
        provider: origin.provider,
        reason: origin.reason,
        resumeAt: decision.kind === "schedule" ? isoAt(decision.resumeAtMs) : null,
        noticeOnly: decision.kind === "notice_only" ? decision.reason : null,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal group could not book a limit resume", {
              groupId: group.groupId,
              roundId: round.roundId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /**
   * A member whose provider is rate limited. One of several addressees is
   * skipped and the round carries on; the only addressee parks the round until
   * the reported reset. Two throttles in a row drop the member from the round.
   *
   * A skipped or dropped member (or a verdict that could not finish) whose
   * provider reported a reset is booked for a resume: at the reset the server
   * reopens the round for that member, unless the owner wrote in the group
   * since, the group was deleted or archived, or it was resumed already.
   */
  const handleThrottle = Effect.fn("PersonalGroupService.handleThrottle")(function* (
    group: GroupRecord,
    round: RoundRecord,
    retryAtMs: number | null,
    detail: string,
    origin: LimitOrigin,
  ) {
    const botId = round.activeBotId;
    if (botId === null) {
      return;
    }
    if (round.activeMessageId?.endsWith("-verdict")) {
      yield* interruptActiveTurn(round, "verdict-throttled");
      yield* abandonActive(group, round);
      const plan = yield* planLimitHit(group, retryAtMs);
      const scheduled = plan?.decision.kind === "schedule";
      yield* commitLimitHit(group, round, "verdict", botId, plan, origin);
      yield* endRound(group, round, "interrupted", {
        event: "round-interrupted",
        text: scheduled
          ? "The final verdict could not finish because its bot was rate limited. The contributions are still available; it will try again after the reset."
          : "The final verdict could not finish because its bot was rate limited. The contributions are still available; send a follow-up to try again.",
      });
      return;
    }
    if (round.activeThreadId !== null) reportedWaits.delete(round.activeThreadId);
    const key = `${round.roundId}:${botId}`;
    const count = (throttles.get(key) ?? 0) + 1;
    throttles.set(key, count);
    const all = yield* liveBots();
    const name = botName(all, botId);
    yield* interruptActiveTurn(round, `throttle-${String(count)}`);
    yield* abandonActive(group, round);
    // The turn produced nothing, so the budget it took is given back: the
    // group's "six replies" has to mean six replies.
    const budgetRemaining = round.budgetRemaining + 1;

    if (count >= MAX_CONSECUTIVE_THROTTLES) {
      yield* writeSystemRow(
        group,
        round.roundId,
        "member-dropped",
        `${name} is still rate limited, so it is out of this round.`,
      );
      yield* writeRound(round, {
        ...clearActive,
        budgetRemaining,
        queue: round.queue.filter((entry) => entry !== botId),
        errorMessage: detail,
      });
      yield* commitLimitHit(
        group,
        round,
        "members",
        botId,
        yield* planLimitHit(group, retryAtMs),
        origin,
      );
      return;
    }
    if (round.queue.length > 0) {
      yield* writeSystemRow(
        group,
        round.roundId,
        "member-skipped",
        `${name} is rate limited, so the group moved on.`,
      );
      yield* writeRound(round, { ...clearActive, budgetRemaining, errorMessage: detail });
      yield* commitLimitHit(
        group,
        round,
        "members",
        botId,
        yield* planLimitHit(group, retryAtMs),
        origin,
      );
      return;
    }
    const now = yield* DateTime.now;
    const availableAt =
      retryAtMs === null
        ? DateTime.add(now, { milliseconds: UNREPORTED_THROTTLE_BACKOFF_MS })
        : DateTime.add(now, { milliseconds: retryAtMs - DateTime.toEpochMillis(now) });
    // The round's clock was set when it started and a usage limit resets hours
    // later: without a new window the wake-up below would find the round out of
    // time and end it instead of letting the member speak.
    const windowEnd = DateTime.add(availableAt, {
      milliseconds: windowMsFor(1 + (round.verdictBotId === null ? 0 : 1)),
    });
    yield* writeRound(round, {
      ...clearActive,
      status: "waiting_provider",
      budgetRemaining,
      queue: [botId],
      availableAt,
      deadlineAt: DateTime.isGreaterThan(windowEnd, round.deadlineAt)
        ? windowEnd
        : round.deadlineAt,
      errorMessage: detail,
    });
    if (retryAtMs !== null) {
      // The round wakes itself at the reset, so this is only the notice line.
      yield* writeSystemRow(
        group,
        round.roundId,
        "member-paused",
        groupPausedText({
          provider: origin.provider,
          reason: origin.reason,
          names: [name],
          decision: { kind: "schedule", resumeAtMs: retryAtMs },
          nowMs: DateTime.toEpochMillis(now),
        }),
      ).pipe(Effect.ignore({ log: true }));
    }
  });

  return { finalReplyText, finishTurn, handleThrottle };
};

export type GroupFinish = ReturnType<typeof makeGroupFinish>;
