// The group service's module-level parts: its timings, work items, ids and small helpers.
import * as DateTime from "effect/DateTime";
import {
  ComposerContextId,
  MessageId,
  PERSONAL_GROUP_MAX_BOT_TURNS_CEILING,
  PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
  PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
  type PersonalReplyQuote,
  makePersonalReplyQuote,
  personalReplyContext,
  PERSONAL_GROUP_ROUND_WALL_CLOCK_MAX_MS,
  PERSONAL_GROUP_ROUND_WALL_CLOCK_MS,
  PERSONAL_GROUP_ROUND_WALL_CLOCK_PER_TURN_MS,
  PersonalGroupRoundId,
  ThreadId,
  type OrchestrationMessageContext,
  type PersonalGroupMessageMarker,
} from "@t3tools/contracts";
import { roundBudget, roundWallClockMs } from "./groupRoundPolicy.ts";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";

export const LEASE_MINUTES = 2;
export const SWEEP_INTERVAL = "30 seconds";
/** Title of a group's shared thread; the group name is the row that shows. */
export const GROUP_THREAD_TITLE = "Group chat";
/** A throttled member that fails twice in one round is out of that round. */
export const MAX_CONSECUTIVE_THROTTLES = 2;
/** Fallback wake-up when a provider reports a limit with no reset time. */
export const UNREPORTED_THROTTLE_BACKOFF_MS = 60_000;

/**
 * The budget of a round, sized to the work it is about to do. The group's
 * frozen `max_bot_turns` is the rail for a mention-driven round and the floor
 * for a broadcast one; see `roundBudget`.
 */
export const budgetFor = (input: {
  readonly frozenMaxBotTurns: number;
  readonly memberCount: number;
  readonly broadcast: boolean;
}): number =>
  roundBudget({
    ...input,
    maxTurnsPerMember: PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
    ceiling: PERSONAL_GROUP_MAX_BOT_TURNS_CEILING,
  });

/** An epoch time as the ISO string the tables and the wire use. */
export const isoAt = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** The wall-clock window for a round with `queuedTurns` still to run. */
export const windowMsFor = (queuedTurns: number): number =>
  roundWallClockMs({
    queuedTurns,
    baseMs: PERSONAL_GROUP_ROUND_WALL_CLOCK_MS,
    perTurnMs: PERSONAL_GROUP_ROUND_WALL_CLOCK_PER_TURN_MS,
    maxMs: PERSONAL_GROUP_ROUND_WALL_CLOCK_MAX_MS,
  });

/**
 * The message context that says who is speaking in a group message. Never
 * referenced from the message text, so `projectComposerContextForProvider`
 * drops it and no provider ever sees it - the same trick task turns use.
 */
export const personalGroupMessageContext = (
  marker: PersonalGroupMessageMarker,
  replyTo?: PersonalReplyQuote,
): OrchestrationMessageContext => ({
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(PERSONAL_GROUP_MESSAGE_CONTEXT_KIND),
      label: "Group chat",
      kind: PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
      payload: marker,
    },
    // A reply's quote rides beside the marker; the catch-up adds it to the
    // text the members read (`readMessageText`).
    ...(replyTo === undefined
      ? []
      : personalReplyContext(makePersonalReplyQuote({ ...replyTo, text: replyTo.excerpt }))
          .records),
  ],
});

export type WorkItem =
  | { readonly type: "pump" }
  | { readonly type: "sweep" }
  | { readonly type: "relay"; readonly threadId: ThreadId; readonly delta: string }
  | { readonly type: "settle"; readonly threadId: ThreadId }
  | { readonly type: "stray"; readonly threadId: ThreadId };

export type RoundRecord = PersonalGroupRepository.PersonalGroupRoundRecord;
export type GroupRecord = PersonalGroupRepository.PersonalGroupRecord;

export const minutesFrom = (now: DateTime.Utc, minutes: number) => DateTime.add(now, { minutes });

/**
 * What the user is told when the wall clock ends a round. The window is sized
 * to the queued work now, so the note says how much of that work happened and
 * how much did not, rather than leaving him to guess. It counts turns taken,
 * not replies delivered: the turn the clock interrupted was taken and may have
 * produced nothing. An expired round keeps no queue, so it points at a
 * follow-up rather than at Continue, which would only close it.
 */
export const expiredNote = (round: RoundRecord): string => {
  const turns = round.spoken.length;
  const waiting = round.queue.length;
  const stillToSpeak =
    waiting === 0
      ? ""
      : `, with ${String(waiting)} ${waiting === 1 ? "member" : "members"} still to speak`;
  return `The group ran out of time after ${String(turns)} ${
    turns === 1 ? "turn" : "turns"
  }${stillToSpeak}. Send a follow-up to carry on.`;
};

/** The group-side message that mirrors one member's reply. */
export const replyMessageId = (roundId: PersonalGroupRoundId, turn: number) =>
  MessageId.make(`personal-group-${roundId}-reply-${turn}`);

/** The user-role brief relayed into a member's own thread. */
export const briefMessageId = (roundId: PersonalGroupRoundId, turn: number) =>
  MessageId.make(`personal-group-${roundId}-brief-${turn}`);
