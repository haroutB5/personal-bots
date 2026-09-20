import * as Schema from "effect/Schema";

import { MessageId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PersonalBotId, PersonalBotThreadNewestMessage } from "./personalBots.ts";

export const PersonalGroupId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalGroupId"));
export type PersonalGroupId = typeof PersonalGroupId.Type;

export const PersonalGroupRoundId = TrimmedNonEmptyString.pipe(
  Schema.brand("PersonalGroupRoundId"),
);
export type PersonalGroupRoundId = typeof PersonalGroupRoundId.Type;

export const PersonalGroupVoteId = TrimmedNonEmptyString.pipe(Schema.brand("PersonalGroupVoteId"));
export type PersonalGroupVoteId = typeof PersonalGroupVoteId.Type;

/**
 * Hard cap on members, enforced by the service and the picker rather than by
 * the schema: every member keeps its own provider thread, so the whole group
 * transcript is stored once per member. Six is the point where that stays
 * affordable and the conversation stays readable.
 */
export const PERSONAL_GROUP_MAX_MEMBERS = 6;

/**
 * Bot turns one user message may spend, frozen on the group row at creation.
 *
 * It is the budget of a round the user aimed at named members. A broadcast
 * round, which queues every member, is instead sized to the group by
 * `roundBudget` and treats this number as a floor, never a cut.
 */
export const PERSONAL_GROUP_DEFAULT_MAX_BOT_TURNS = 6;

/**
 * The hard cap on any round's budget: the largest `maxBotTurns` a group may be
 * created with, and the clamp on a broadcast round's size-scaled budget.
 *
 * Twelve is exactly `PERSONAL_GROUP_MAX_MEMBERS *
 * PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND`, which is the most turns the
 * per-member cap can ever admit into one round, so it is sufficient rather
 * than merely generous: the biggest legal group can take every turn its own
 * cap allows - the opening pass and a follow-up each - without the budget
 * pausing it. It is deliberately not raised past that; every extra turn is a
 * real provider call.
 */
export const PERSONAL_GROUP_MAX_BOT_TURNS_CEILING = 12;

/** How often one member may speak inside a single round. */
export const PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND = 2;

/**
 * Characters of catch-up a speaking member is handed. Older messages collapse
 * to "[… N earlier messages omitted]" rather than growing without bound.
 */
export const PERSONAL_GROUP_CATCHUP_MAX_CHARS = 12_000;

/**
 * The window a round gets whatever its size; `roundWallClockMs` grows it with
 * the queued work. A round that has not finished inside its window is swept.
 */
export const PERSONAL_GROUP_ROUND_WALL_CLOCK_MS = 10 * 60 * 1000;

/**
 * Added to the window per queued turn. Members speak one at a time
 * ({@link PERSONAL_GROUP_CONCURRENCY}), so a round's honest duration is its
 * queue length times one provider turn; three minutes covers a research turn
 * that reads a few pages.
 */
export const PERSONAL_GROUP_ROUND_WALL_CLOCK_PER_TURN_MS = 3 * 60 * 1000;

/**
 * The longest any round may run. The worst legal round is thirteen turns (the
 * twelve-turn ceiling plus the reserved verdict), so forty-five minutes is
 * above the honest worst case rather than a cliff it would hit routinely,
 * while still guaranteeing the single speaking slot comes back.
 */
export const PERSONAL_GROUP_ROUND_WALL_CLOCK_MAX_MS = 45 * 60 * 1000;

/**
 * Exactly one member speaks at a time, server-wide. This slot is its own, and
 * disjoint from the task system's, so the worst case stays bounded.
 */
export const PERSONAL_GROUP_CONCURRENCY = 1;

/**
 * Marks a message the group service wrote, and says who is speaking. Rides on
 * the message's `context` exactly as {@link PERSONAL_TASK_MESSAGE_CONTEXT_KIND}
 * does: no message text references the record, so
 * `projectComposerContextForProvider` drops it and providers never see it,
 * while clients read attribution straight off the message with no join.
 */
export const PERSONAL_GROUP_MESSAGE_CONTEXT_KIND = "personal-group";

/** v1 has members only; the coordinator role exists so v2 needs no migration. */
export const PersonalGroupMemberRole = Schema.Literals(["member", "coordinator"]);
export type PersonalGroupMemberRole = typeof PersonalGroupMemberRole.Type;

/** System rows the group service writes into the transcript on its own behalf. */
export const PersonalGroupSystemEvent = Schema.Literals([
  "member-added",
  "member-removed",
  "member-skipped",
  "member-dropped",
  "round-paused-budget",
  "round-stopped",
  "round-interrupted",
  /** Two members were answering only each other, so the round ended (§2.5). */
  "round-ended-loop",
  /** A turn was started on the group thread from outside the group service. */
  "stray-turn-stopped",
  "vote-opened",
  "vote-resolved",
  "vote-approved",
  "vote-rejected",
]);
export type PersonalGroupSystemEvent = typeof PersonalGroupSystemEvent.Type;

export const PersonalGroupSpeaker = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user") }),
  Schema.Struct({
    kind: Schema.Literal("bot"),
    botId: PersonalBotId,
    /** The bot's name as it was when it spoke; renames never rewrite history. */
    name: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("system"),
    event: PersonalGroupSystemEvent,
  }),
]);
export type PersonalGroupSpeaker = typeof PersonalGroupSpeaker.Type;

export const PersonalGroupMessageMarker = Schema.Struct({
  groupId: PersonalGroupId,
  /** The message's position in `personal_group_messages`; 0 before it is logged. */
  seq: NonNegativeInt,
  /** The round that produced it; null for messages written outside a round. */
  roundId: Schema.NullOr(PersonalGroupRoundId),
  speaker: PersonalGroupSpeaker,
  phase: Schema.optional(Schema.Literals(["discussion", "verdict"])),
  /**
   * True on the catch-up brief a member is handed inside its OWN thread, so the
   * client can render it as a relayed group brief rather than as something the
   * owner typed. Absent on the group transcript's own messages.
   */
  relayedFromGroup: Schema.optional(Schema.Boolean),
});
export type PersonalGroupMessageMarker = typeof PersonalGroupMessageMarker.Type;

export const PersonalGroupMember = Schema.Struct({
  groupId: PersonalGroupId,
  botId: PersonalBotId,
  /** The member's own provider thread; null until the member first speaks. */
  threadId: Schema.NullOr(ThreadId),
  role: PersonalGroupMemberRole,
  sortOrder: Schema.Number,
  /** Catch-up cursor: the highest group `seq` this member has been shown. */
  deliveredSeq: NonNegativeInt,
  joinedAt: Schema.DateTimeUtcFromString,
  leftAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalGroupMember = typeof PersonalGroupMember.Type;

export const PersonalGroup = Schema.Struct({
  groupId: PersonalGroupId,
  name: Schema.String,
  description: Schema.String,
  /** The shared orchestration thread everyone reads. Never a bot thread. */
  threadId: ThreadId,
  /** Frozen at creation, like a root task's maxDepth/maxChildren. */
  maxBotTurns: Schema.Number,
  members: Schema.Array(PersonalGroupMember),
  /** Only on `personalGroups.list`, mirroring `PersonalBotThread.newestMessage`. */
  newestMessage: Schema.optional(Schema.NullOr(PersonalBotThreadNewestMessage)),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  archivedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalGroup = typeof PersonalGroup.Type;

/**
 * running: a member is speaking or queued. paused_budget: the round spent its
 * bot turns and waits for Continue. paused_vote: a resolved vote waits for the
 * owner's Approve/Reject (§V.3) — a round never closes over one.
 * waiting_provider: the only addressee is rate limited; `availableAt` says
 * when the sweep retries. completed / stopped / interrupted are terminal;
 * interrupted is what a server restart leaves behind.
 */
export const PersonalGroupRoundStatus = Schema.Literals([
  "running",
  "paused_budget",
  "paused_vote",
  "waiting_provider",
  "completed",
  "stopped",
  "interrupted",
]);
export type PersonalGroupRoundStatus = typeof PersonalGroupRoundStatus.Type;

export const PersonalGroupRound = Schema.Struct({
  roundId: PersonalGroupRoundId,
  groupId: PersonalGroupId,
  /** The user message that opened the round. */
  triggerMessageId: MessageId,
  status: PersonalGroupRoundStatus,
  /** Bot turns still available in this round. */
  budgetRemaining: NonNegativeInt,
  /** Bots waiting to speak, in order. */
  queue: Schema.Array(PersonalBotId),
  /** Bots that have already spoken, in order, including repeats. */
  spoken: Schema.Array(PersonalBotId),
  activeBotId: Schema.NullOr(PersonalBotId),
  activeThreadId: Schema.NullOr(ThreadId),
  activeMessageId: Schema.NullOr(MessageId),
  /** Characters of the active reply already mirrored into the group thread. */
  relayedChars: NonNegativeInt,
  /** When a provider-throttled round becomes claimable again. */
  availableAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  deadlineAt: Schema.DateTimeUtcFromString,
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PersonalGroupRound = typeof PersonalGroupRound.Type;

/**
 * open: ballots are still coming in. decided: every eligible member balloted
 * (or the wall clock expired) and the tally is waiting for the owner.
 * approved / rejected: the owner answered. expired: the round ended before the
 * owner did.
 */
export const PersonalGroupVoteStatus = Schema.Literals([
  "open",
  "decided",
  "approved",
  "rejected",
  "expired",
]);
export type PersonalGroupVoteStatus = typeof PersonalGroupVoteStatus.Type;

export const PersonalGroupVoteBallot = Schema.Struct({
  voteId: PersonalGroupVoteId,
  botId: PersonalBotId,
  /** Must be one of the vote's options. */
  option: Schema.String,
  /** One line. Shown on the tally card beside the member's choice. */
  reason: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
});
export type PersonalGroupVoteBallot = typeof PersonalGroupVoteBallot.Type;

export const PersonalGroupVote = Schema.Struct({
  voteId: PersonalGroupVoteId,
  groupId: PersonalGroupId,
  roundId: PersonalGroupRoundId,
  calledByBotId: PersonalBotId,
  question: Schema.String,
  /**
   * The question with case, punctuation and whitespace flattened. A reworded
   * re-ask of a question already decided in this round matches here and is
   * refused, so a losing side cannot simply ask again.
   */
  questionNormalised: Schema.String,
  options: Schema.Array(Schema.String),
  status: PersonalGroupVoteStatus,
  /** The plurality winner; null while open, and null on an exact tie. */
  winningOption: Schema.NullOr(Schema.String),
  ballots: Schema.Array(PersonalGroupVoteBallot),
  createdAt: Schema.DateTimeUtcFromString,
  decidedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type PersonalGroupVote = typeof PersonalGroupVote.Type;

/**
 * Ballot papers a bot may put up. Two is the smallest question worth a vote;
 * the ceiling keeps the tally card readable and the plurality meaningful.
 */
export const PERSONAL_GROUP_VOTE_MIN_OPTIONS = 2;
export const PERSONAL_GROUP_VOTE_MAX_OPTIONS = 6;

/**
 * The owner's answer to a resolved vote. `approve` relays the winning option
 * into a member's thread as its next instruction; `reject` records the refusal
 * and lets the discussion carry on. There is no third answer and no default:
 * a vote that is never answered simply never acts, which is the point.
 */
export const PersonalGroupVoteDecision = Schema.Literals(["approve", "reject"]);
export type PersonalGroupVoteDecision = typeof PersonalGroupVoteDecision.Type;

export const PersonalGroupVoteDecisionInput = Schema.Struct({
  voteId: PersonalGroupVoteId,
  decision: PersonalGroupVoteDecision,
});
export type PersonalGroupVoteDecisionInput = typeof PersonalGroupVoteDecisionInput.Type;

/** Client-minted ids make create idempotent, as `personalBots.create` is. */
export const PersonalGroupCreateInput = Schema.Struct({
  groupId: PersonalGroupId,
  threadId: ThreadId,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Defaults to {@link PERSONAL_GROUP_DEFAULT_MAX_BOT_TURNS}; capped at the ceiling. */
  maxBotTurns: Schema.optional(Schema.Number),
  /** At most {@link PERSONAL_GROUP_MAX_MEMBERS}, in the order they are listed. */
  botIds: Schema.Array(PersonalBotId),
});
export type PersonalGroupCreateInput = typeof PersonalGroupCreateInput.Type;

export const PersonalGroupUpdateInput = Schema.Struct({
  groupId: PersonalGroupId,
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Boolean),
});
export type PersonalGroupUpdateInput = typeof PersonalGroupUpdateInput.Type;

export const PersonalGroupIdInput = Schema.Struct({
  groupId: PersonalGroupId,
});
export type PersonalGroupIdInput = typeof PersonalGroupIdInput.Type;

/**
 * Deleting a group, and optionally the member bots the owner ticked in the
 * confirm sheet. `purgeBotIds` is the full list of bots to destroy outright -
 * each one loses its chats, files, routines, bot-scoped memories and its
 * membership of every OTHER group too, through the one `purgePersonalBot`
 * path. Omitted or empty means "delete the group only", which is what this
 * method has always done and still does.
 *
 * Optional on the wire so a client built before this field still deletes a
 * group. Every id must name a CURRENT member of that group or the whole call
 * is refused before anything is touched, so a stale sheet can never destroy a
 * bot the owner did not see listed.
 */
export const PersonalGroupDeleteInput = Schema.Struct({
  groupId: PersonalGroupId,
  purgeBotIds: Schema.optional(Schema.Array(PersonalBotId)),
});
export type PersonalGroupDeleteInput = typeof PersonalGroupDeleteInput.Type;

/**
 * The owner unparking a round. Bare, it is Continue (§2.4): a round that spent
 * its bot turns gets a fresh `maxBotTurns`. With `vote`, it is the approval
 * gate (§V.3): approve relays the winning option into a member's thread as its
 * next instruction and the round runs on with whatever budget it had left;
 * reject records the refusal and lets the discussion continue.
 *
 * One input, because it is one act - a parked round only ever moves because
 * the owner said so, and that is precisely why a bot-only majority can never
 * start work on its own.
 */
export const PersonalGroupContinueRoundInput = Schema.Struct({
  groupId: PersonalGroupId,
  vote: Schema.optional(PersonalGroupVoteDecisionInput),
});
export type PersonalGroupContinueRoundInput = typeof PersonalGroupContinueRoundInput.Type;

export const PersonalGroupMemberInput = Schema.Struct({
  groupId: PersonalGroupId,
  botId: PersonalBotId,
  role: Schema.optional(PersonalGroupMemberRole),
});
export type PersonalGroupMemberInput = typeof PersonalGroupMemberInput.Type;

export const PersonalGroupSendMessageInput = Schema.Struct({
  groupId: PersonalGroupId,
  /** Client-minted, so a resend of the same message opens no second round. */
  messageId: MessageId,
  text: Schema.String,
});
export type PersonalGroupSendMessageInput = typeof PersonalGroupSendMessageInput.Type;

export const PersonalGroupListResult = Schema.Struct({
  groups: Schema.Array(PersonalGroup),
  /** Rounds that are not terminal, so a fresh client can show them at once. */
  rounds: Schema.Array(PersonalGroupRound),
  /** Votes of those rounds, so a parked tally card paints on first load. */
  votes: Schema.Array(PersonalGroupVote),
});
export type PersonalGroupListResult = typeof PersonalGroupListResult.Type;

/**
 * `personalGroups.subscribe` replays state, then streams changes. STATE ONLY:
 * the transcript arrives on the group thread's ordinary thread-detail
 * subscription, so the phone holds one subscription for the conversation.
 */
export const PersonalGroupStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("group"), group: PersonalGroup }),
  Schema.Struct({ type: Schema.Literal("round"), round: PersonalGroupRound }),
  /**
   * A vote and its ballots. Structured on purpose: the tally card shows every
   * member's choice with its reason, which cannot be recovered from a line of
   * transcript text.
   */
  Schema.Struct({ type: Schema.Literal("vote"), vote: PersonalGroupVote }),
]);
export type PersonalGroupStreamEvent = typeof PersonalGroupStreamEvent.Type;

export class PersonalGroupsError extends Schema.TaggedError<PersonalGroupsError>()(
  "PersonalGroupsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
