import * as NodeCrypto from "node:crypto";

import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CommandId,
  ComposerContextId,
  MessageId,
  PERSONAL_GROUP_CATCHUP_MAX_CHARS,
  PERSONAL_GROUP_CONCURRENCY,
  PERSONAL_GROUP_DEFAULT_MAX_BOT_TURNS,
  PERSONAL_GROUP_MAX_BOT_TURNS_CEILING,
  PERSONAL_GROUP_MAX_MEMBERS,
  PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
  PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
  PERSONAL_GROUP_ROUND_WALL_CLOCK_MAX_MS,
  PERSONAL_GROUP_ROUND_WALL_CLOCK_MS,
  PERSONAL_GROUP_ROUND_WALL_CLOCK_PER_TURN_MS,
  PERSONAL_GROUP_VOTE_MAX_OPTIONS,
  PERSONAL_GROUP_VOTE_MIN_OPTIONS,
  PersonalGroupId,
  PersonalGroupRoundId,
  PersonalGroupsError,
  PersonalGroupVoteId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationMessageContext,
  type OrchestrationSession,
  type PersonalBot,
  type PersonalBotId,
  type PersonalGroup,
  type PersonalGroupContinueRoundInput,
  type PersonalGroupCreateInput,
  type PersonalGroupIdInput,
  type PersonalGroupListResult,
  type PersonalGroupMember,
  type PersonalGroupMemberInput,
  type PersonalGroupMessageMarker,
  type PersonalGroupRound,
  type PersonalGroupSendMessageInput,
  type PersonalGroupStreamEvent,
  type PersonalGroupSystemEvent,
  type PersonalGroupUpdateInput,
  type PersonalGroupVote,
  type PersonalGroupVoteBallot,
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { classifyProviderError, providerWaitPause } from "../tasks/PersonalTaskService.ts";
import {
  groupExposureKey,
  makeSensitiveExposureStore,
  threadExposureKey,
} from "../browser/sensitiveExposureStore.ts";
import { parseMentions } from "./groupMentions.ts";
import { admitMentions, nextStep, roundBudget, roundWallClockMs } from "./groupRoundPolicy.ts";
import { buildCatchUpBrief, type GroupCatchUpMessage } from "./groupTurnText.ts";
import { normaliseQuestion, tallyVote } from "./groupVotePolicy.ts";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";

const LEASE_MINUTES = 2;
const SWEEP_INTERVAL = "30 seconds";
/** Title of a group's shared thread; the group name is the row that shows. */
const GROUP_THREAD_TITLE = "Group chat";
/** A throttled member that fails twice in one round is out of that round. */
const MAX_CONSECUTIVE_THROTTLES = 2;
/** Fallback wake-up when a provider reports a limit with no reset time. */
const UNREPORTED_THROTTLE_BACKOFF_MS = 60_000;

/**
 * The budget of a round, sized to the work it is about to do. The group's
 * frozen `max_bot_turns` is the rail for a mention-driven round and the floor
 * for a broadcast one; see `roundBudget`.
 */
const budgetFor = (input: {
  readonly frozenMaxBotTurns: number;
  readonly memberCount: number;
  readonly broadcast: boolean;
}): number =>
  roundBudget({
    ...input,
    maxTurnsPerMember: PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
    ceiling: PERSONAL_GROUP_MAX_BOT_TURNS_CEILING,
  });

/** The wall-clock window for a round with `queuedTurns` still to run. */
const windowMsFor = (queuedTurns: number): number =>
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
  ],
});

export class PersonalGroupService extends Context.Service<
  PersonalGroupService,
  {
    readonly list: () => Effect.Effect<PersonalGroupListResult, PersonalGroupsError>;
    readonly create: (
      input: PersonalGroupCreateInput,
    ) => Effect.Effect<PersonalGroup, PersonalGroupsError>;
    readonly update: (
      input: PersonalGroupUpdateInput,
    ) => Effect.Effect<PersonalGroup, PersonalGroupsError>;
    readonly remove: (input: PersonalGroupIdInput) => Effect.Effect<void, PersonalGroupsError>;
    readonly addMember: (
      input: PersonalGroupMemberInput,
    ) => Effect.Effect<PersonalGroup, PersonalGroupsError>;
    readonly removeMember: (
      input: PersonalGroupMemberInput,
    ) => Effect.Effect<PersonalGroup, PersonalGroupsError>;
    /** Appends the message to the group thread and opens a round for it. */
    readonly sendMessage: (
      input: PersonalGroupSendMessageInput,
    ) => Effect.Effect<PersonalGroupRound, PersonalGroupsError>;
    /**
     * The owner unparking a round: a fresh budget, or the Approve / Reject of
     * a resolved vote (§V.3). Nothing a vote decided runs before this call.
     */
    readonly continueRound: (
      input: PersonalGroupContinueRoundInput,
    ) => Effect.Effect<PersonalGroupRound, PersonalGroupsError>;
    /**
     * Opens a vote inside the caller's own live group turn. Refuses outside a
     * round, over an already-open vote, and on a question this round already
     * decided however it is reworded (§V.2).
     */
    readonly callVote: (input: {
      readonly threadId: ThreadId;
      readonly question: string;
      readonly options: ReadonlyArray<string>;
    }) => Effect.Effect<
      { readonly vote: PersonalGroupVote; readonly voterNames: ReadonlyArray<string> },
      PersonalGroupsError
    >;
    /** One ballot, from the member whose turn is live. */
    readonly castVote: (input: {
      readonly threadId: ThreadId;
      readonly voteId: PersonalGroupVoteId;
      readonly option: string;
      readonly reason: string;
    }) => Effect.Effect<PersonalGroupVote, PersonalGroupsError>;
    /** Stops every member: clears the queue and interrupts the live turn. */
    readonly stop: (input: PersonalGroupIdInput) => Effect.Effect<void, PersonalGroupsError>;
    /** Replay of every group and live round, then live changes. State only. */
    readonly subscribe: Stream.Stream<PersonalGroupStreamEvent, PersonalGroupsError>;
    readonly changes: Stream.Stream<PersonalGroupStreamEvent>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly ingestDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
    readonly sweep: Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    /**
     * The name of the group `threadId` is a member thread of, if any. A chat
     * delete uses it to refuse: deleting a member thread mid-group would strip
     * the member's whole memory of the conversation behind its back.
     */
    readonly groupNameForMemberThread: (threadId: ThreadId) => Effect.Effect<Option.Option<string>>;
    /**
     * Drops a deleted bot's memberships, says so in each group's transcript
     * and archives a group the deletion emptied. Called by `purgePersonalBot`
     * BEFORE the bot's threads are deleted, so the rows it reads still exist.
     */
    readonly purgeBot: (input: {
      readonly botId: PersonalBotId;
    }) => Effect.Effect<void, PersonalGroupsError>;
  }
>()("t3/personal/groups/PersonalGroupService") {}

type WorkItem =
  | { readonly type: "pump" }
  | { readonly type: "sweep" }
  | { readonly type: "relay"; readonly threadId: ThreadId; readonly delta: string }
  | { readonly type: "settle"; readonly threadId: ThreadId }
  | { readonly type: "stray"; readonly threadId: ThreadId };

type RoundRecord = PersonalGroupRepository.PersonalGroupRoundRecord;
type GroupRecord = PersonalGroupRepository.PersonalGroupRecord;

const minutesFrom = (now: DateTime.Utc, minutes: number) => DateTime.add(now, { minutes });

/**
 * What the user is told when the wall clock ends a round. The window is sized
 * to the queued work now, so the note says how much of that work happened and
 * how much did not, rather than leaving him to guess. It counts turns taken,
 * not replies delivered: the turn the clock interrupted was taken and may have
 * produced nothing. An expired round keeps no queue, so it points at a
 * follow-up rather than at Continue, which would only close it.
 */
const expiredNote = (round: RoundRecord): string => {
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
const replyMessageId = (roundId: PersonalGroupRoundId, turn: number) =>
  MessageId.make(`personal-group-${roundId}-reply-${turn}`);

/** The user-role brief relayed into a member's own thread. */
const briefMessageId = (roundId: PersonalGroupRoundId, turn: number) =>
  MessageId.make(`personal-group-${roundId}-brief-${turn}`);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalGroupRepository.PersonalGroupRepository;
  // The sensitive-site taint travels with the transcript: a member's reply
  // carries its thread's taint into the group, and the group's taint rides the
  // catch-up brief into the next speaker's thread (audit K2).
  const exposures = makeSensitiveExposureStore(yield* SqlClient.SqlClient);
  const carryTaint = (from: ReadonlyArray<string>, to: string) =>
    exposures.copySources(from, to).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("personal groups could not carry a sensitive-site taint", {
          to,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  const botRepository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const messages = yield* ProjectionThreadMessageRepository;

  const leaseOwner = `personal-groups:${NodeCrypto.randomUUID()}`;
  const upserts = yield* PubSub.unbounded<PersonalGroupStreamEvent>();
  // Serialises public mutations with dispatcher steps: a relay must never
  // interleave with a stop or a member removal on the same round.
  const lock = yield* Semaphore.make(1);
  /**
   * Every group's shared thread. Two jobs: the feedback-loop guard (events on
   * G are the relay's own output and must never be re-read as input, §2.6) and
   * spotting a stray turn started on G from the developer view (§3.4).
   */
  const groupThreadIds = new Set<string>();
  /** Member threads with a live relay; filters the hot domain-event stream. */
  const activeMemberThreadIds = new Set<string>();
  /**
   * Consecutive provider throttles per member per round. In memory on purpose:
   * a restart ends the round anyway (§2.6), so there is nothing to carry.
   */
  const throttles = new Map<string, number>();

  const fail = (message: string, cause?: unknown) =>
    new PersonalGroupsError({ message, ...(cause === undefined ? {} : { cause }) });

  const toPublic =
    (operation: string) =>
    <A, R>(
      effect: Effect.Effect<
        A,
        PersonalGroupsError | PersonalGroupRepository.PersonalGroupRepositoryError,
        R
      >,
    ) =>
      effect.pipe(
        Effect.mapError((error) =>
          error._tag === "PersonalGroupsError"
            ? error
            : fail(`Personal groups ${operation} failed.`, error),
        ),
      );

  const toRound = (record: RoundRecord): PersonalGroupRound => ({
    roundId: record.roundId,
    groupId: record.groupId,
    triggerMessageId: record.triggerMessageId,
    status: record.status,
    budgetRemaining: record.budgetRemaining,
    queue: record.queue,
    spoken: record.spoken,
    activeBotId: record.activeBotId,
    activeThreadId: record.activeThreadId,
    activeMessageId: record.activeMessageId,
    relayedChars: record.relayedChars,
    availableAt: record.availableAt,
    deadlineAt: record.deadlineAt,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });

  const refreshCaches = Effect.fn("PersonalGroupService.refreshCaches")(function* () {
    const groups = yield* repository.listGroups();
    groupThreadIds.clear();
    for (const group of groups) {
      groupThreadIds.add(group.threadId);
    }
    const rounds = yield* repository.listLiveRounds();
    activeMemberThreadIds.clear();
    for (const round of rounds) {
      if (round.activeThreadId !== null) {
        activeMemberThreadIds.add(round.activeThreadId);
      }
    }
  });

  const requireGroup = Effect.fn("PersonalGroupService.requireGroup")(function* (
    groupId: PersonalGroupId,
  ) {
    const group = yield* repository.getGroup(groupId);
    if (Option.isNone(group)) {
      return yield* fail(`Group '${groupId}' was not found.`);
    }
    return group.value;
  });

  const requireLiveBot = Effect.fn("PersonalGroupService.requireLiveBot")(function* (
    botId: PersonalBotId,
  ) {
    const live = yield* botRepository
      .listBots()
      .pipe(Effect.mapError((cause) => fail("Personal groups bot lookup failed.", cause)));
    const bot = live.find((entry) => entry.botId === botId);
    if (bot === undefined) {
      return yield* fail(`Personal bot '${botId}' was not found.`);
    }
    return bot;
  });

  const liveBots = () =>
    botRepository
      .listBots()
      .pipe(Effect.mapError((cause) => fail("Personal groups bot lookup failed.", cause)));

  const botName = (all: ReadonlyArray<PersonalBot>, botId: PersonalBotId) =>
    all.find((bot) => bot.botId === botId)?.name ?? "A bot";

  const readMessageText = (messageId: MessageId) =>
    messages.getByMessageId({ messageId }).pipe(
      Effect.map((row) => (Option.isSome(row) ? row.value.text : "")),
      Effect.orElseSucceed(() => ""),
    );

  const toPublicGroup = Effect.fn("PersonalGroupService.toPublicGroup")(function* (
    group: GroupRecord,
    options: { readonly withNewestMessage: boolean } = { withNewestMessage: false },
  ) {
    const members = yield* repository.listMembers(group.groupId);
    const base = {
      groupId: group.groupId,
      name: group.name,
      description: group.description,
      threadId: group.threadId,
      maxBotTurns: group.maxBotTurns,
      members,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      archivedAt: group.archivedAt,
    } satisfies Omit<PersonalGroup, "newestMessage">;
    if (!options.withNewestMessage) {
      return base as PersonalGroup;
    }
    const log = yield* repository.listMessagesAfter({ groupId: group.groupId, afterSeq: 0 });
    const newest = log.at(-1);
    if (newest === undefined) {
      return { ...base, newestMessage: null } satisfies PersonalGroup;
    }
    const row = yield* messages
      .getByMessageId({ messageId: newest.messageId })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return {
      ...base,
      newestMessage: Option.isNone(row)
        ? null
        : {
            id: row.value.messageId,
            role: row.value.role,
            text: row.value.text,
            ...(row.value.context === undefined ? {} : { context: row.value.context }),
          },
    } satisfies PersonalGroup;
  });

  const publishGroup = Effect.fn("PersonalGroupService.publishGroup")(function* (
    group: GroupRecord,
  ) {
    const published = yield* toPublicGroup(group);
    yield* PubSub.publish(upserts, { type: "group", group: published });
    return published;
  });

  const publishRound = (round: RoundRecord) =>
    PubSub.publish(upserts, { type: "round", round: toRound(round) });

  // ---------------------------------------------------------------------
  // Writing into the group transcript
  // ---------------------------------------------------------------------

  const dispatchOrLog = (operation: string, command: Parameters<typeof engine.dispatch>[0]) =>
    engine.dispatch(command).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal groups could not dispatch an orchestration command", {
              operation,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  /**
   * Mirrors text into the group transcript as an assistant message. Only the
   * first delta of a message carries the marker: the projection preserves it
   * across later deltas and the completing upsert.
   */
  const relayDelta = Effect.fn("PersonalGroupService.relayDelta")(function* (input: {
    readonly group: GroupRecord;
    readonly messageId: MessageId;
    readonly delta: string;
    readonly offset: number;
    readonly marker: PersonalGroupMessageMarker | null;
  }) {
    yield* dispatchOrLog("relay delta", {
      type: "thread.message.assistant.delta",
      commandId: CommandId.make(`personal-group:${input.messageId}:delta:${String(input.offset)}`),
      threadId: input.group.threadId,
      messageId: input.messageId,
      delta: input.delta,
      ...(input.marker === null ? {} : { context: personalGroupMessageContext(input.marker) }),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const relayComplete = Effect.fn("PersonalGroupService.relayComplete")(function* (input: {
    readonly group: GroupRecord;
    readonly messageId: MessageId;
  }) {
    yield* dispatchOrLog("relay complete", {
      type: "thread.message.assistant.complete",
      commandId: CommandId.make(`personal-group:${input.messageId}:complete`),
      threadId: input.group.threadId,
      messageId: input.messageId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  /** A server-authored line in the transcript: joins, skips, pauses, stops. */
  const writeSystemRow = Effect.fn("PersonalGroupService.writeSystemRow")(function* (
    group: GroupRecord,
    roundId: PersonalGroupRoundId | null,
    event: PersonalGroupSystemEvent,
    text: string,
  ) {
    const now = yield* DateTime.now;
    const messageId = MessageId.make(`personal-group-sys-${NodeCrypto.randomUUID()}`);
    const row = yield* repository.insertMessage({
      groupId: group.groupId,
      messageId,
      speakerKind: "system",
      speakerBotId: null,
      roundId,
      createdAt: now,
    });
    yield* relayDelta({
      group,
      messageId,
      delta: text,
      offset: 0,
      marker: {
        groupId: group.groupId,
        seq: row.seq,
        roundId,
        speaker: { kind: "system", event },
      },
    });
    yield* relayComplete({ group, messageId });
  });

  // ---------------------------------------------------------------------
  // Voting (§V)
  // ---------------------------------------------------------------------

  const publishVote = (vote: PersonalGroupVote) => PubSub.publish(upserts, { type: "vote", vote });

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

    const dispatched = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`personal-group:${round.roundId}:${String(turn)}:turn.start`),
        threadId,
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
      const speaking = live.filter((round) => round.activeBotId !== null).length;
      if (speaking >= PERSONAL_GROUP_CONCURRENCY) {
        // PERSONAL_GROUP_CONCURRENCY = 1, and this slot is disjoint from the
        // task system's two, so the worst case stays three provider turns.
        return;
      }
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const round = live.find(
        (entry) =>
          entry.status === "running" &&
          (entry.availableAt === null || DateTime.toEpochMillis(entry.availableAt) <= nowMs),
      );
      if (round === undefined) {
        return;
      }
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
            text: `${botName(all, second!)} and ${botName(all, first!)} were replying to each other, so the round ended.`,
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
            text: `Paused after ${String(granted)} replies. Continue to give the group another ${String(granted)}.`,
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

  /**
   * A member whose provider is rate limited. One of several addressees is
   * skipped and the round carries on; the only addressee parks the round until
   * the reported reset. Two throttles in a row drop the member from the round.
   */
  const handleThrottle = Effect.fn("PersonalGroupService.handleThrottle")(function* (
    group: GroupRecord,
    round: RoundRecord,
    retryAtMs: number | null,
    detail: string,
  ) {
    const botId = round.activeBotId;
    if (botId === null) {
      return;
    }
    if (round.activeMessageId?.endsWith("-verdict")) {
      yield* interruptActiveTurn(round, "verdict-throttled");
      yield* abandonActive(group, round);
      yield* endRound(group, round, "interrupted", {
        event: "round-interrupted",
        text: "The final verdict could not finish because its bot was rate limited. The contributions are still available; send a follow-up to try again.",
      });
      return;
    }
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
      return;
    }
    const now = yield* DateTime.now;
    yield* writeRound(round, {
      ...clearActive,
      status: "waiting_provider",
      budgetRemaining,
      queue: [botId],
      availableAt:
        retryAtMs === null
          ? DateTime.add(now, { milliseconds: UNREPORTED_THROTTLE_BACKOFF_MS })
          : DateTime.add(now, { milliseconds: retryAtMs - DateTime.toEpochMillis(now) }),
      errorMessage: detail,
    });
  });

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
      const pause = providerWaitPause(session.providerRetry, DateTime.toEpochMillis(now));
      if (pause !== null) {
        yield* handleThrottle(
          group,
          round,
          pause.retryAtMs,
          pause.retry.reason ?? "The provider is rate limited.",
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
        const limit =
          session.providerRetry?.kind === "rate_limited" ? session.providerRetry : undefined;
        const resetMs = limit?.retryAt === undefined ? Number.NaN : Date.parse(limit.retryAt);
        if (limit !== undefined || classifyProviderError(session.lastError) === "rate_limited") {
          yield* handleThrottle(
            group,
            round,
            Number.isFinite(resetMs) ? resetMs : null,
            session.lastError ?? "The provider is rate limited.",
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
    const all = yield* liveBots();
    const reserved = yield* repository.getMessageByMessageId(round.activeMessageId);
    yield* relayDelta({
      group,
      messageId: round.activeMessageId,
      delta,
      offset: round.relayedChars,
      marker:
        round.relayedChars > 0 || Option.isNone(reserved)
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
    yield* pump;
  });

  const processItem = (item: WorkItem) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          switch (item.type) {
            case "pump":
              break;
            case "sweep":
              yield* sweepOnce();
              return;
            case "relay":
              yield* relayFromMember(item.threadId, item.delta);
              return;
            case "settle":
              yield* settleActive(item.threadId);
              break;
            case "stray":
              yield* stopStrayTurn(item.threadId);
              return;
          }
          yield* pump;
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("personal groups dispatcher step failed", {
                item: item.type,
                cause: Cause.pretty(cause),
              }),
        ),
      );

  const worker = yield* makeDrainableWorker(processItem);

  yield* refreshCaches().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("personal groups could not load their state", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const ingestDomainEvent: PersonalGroupService["Service"]["ingestDomainEvent"] = (event) => {
    switch (event.type) {
      case "thread.message-sent": {
        const threadId = event.payload.threadId;
        // The feedback-loop guard: everything on a group thread is this
        // service's own relay output. Reading it back would restart the round.
        if (groupThreadIds.has(threadId)) {
          return Effect.void;
        }
        if (!activeMemberThreadIds.has(threadId) || event.payload.role !== "assistant") {
          return Effect.void;
        }
        return event.payload.streaming
          ? worker.enqueue({ type: "relay", threadId, delta: event.payload.text })
          : worker.enqueue({ type: "settle", threadId });
      }
      case "thread.session-set": {
        const threadId = event.payload.threadId;
        return activeMemberThreadIds.has(threadId)
          ? worker.enqueue({ type: "settle", threadId })
          : Effect.void;
      }
      case "thread.turn-start-requested": {
        const threadId = event.payload.threadId;
        return groupThreadIds.has(threadId)
          ? worker.enqueue({ type: "stray", threadId })
          : Effect.void;
      }
      default:
        return Effect.void;
    }
  };

  // ---------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------

  const list: PersonalGroupService["Service"]["list"] = () =>
    Effect.gen(function* () {
      const groups = yield* repository.listGroups();
      const published = yield* Effect.forEach(groups, (group) =>
        toPublicGroup(group, { withNewestMessage: true }),
      );
      const live = yield* repository.listLiveRounds();
      const votes = yield* repository.listPendingVotesForRounds(live.map((round) => round.roundId));
      // A group with no live round still reports its newest one, terminal or
      // not. A client that missed the round ending (a phone asleep, a socket
      // reconnecting) otherwise keeps its last "running" copy forever: the
      // replay it resubscribes to would never mention the round again.
      const liveGroupIds = new Set(live.map((round) => round.groupId));
      const settled = yield* Effect.forEach(
        groups.filter((group) => !liveGroupIds.has(group.groupId)),
        (group) => repository.latestRoundForGroup(group.groupId),
      );
      const rounds = [...live, ...settled.flatMap((round) => Option.toArray(round))];
      return {
        groups: published,
        rounds: rounds.map(toRound),
        votes,
      } satisfies PersonalGroupListResult;
    }).pipe(toPublic("list"));

  const create: PersonalGroupService["Service"]["create"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const existing = yield* repository.getGroup(input.groupId);
          if (Option.isSome(existing)) {
            // The client minted the id, so a replayed create is the same group.
            return yield* toPublicGroup(existing.value);
          }
          const botIds = [...new Set(input.botIds)];
          if (botIds.length === 0) {
            return yield* fail("A group needs at least one bot.");
          }
          if (botIds.length > PERSONAL_GROUP_MAX_MEMBERS) {
            return yield* fail(
              `A group can have at most ${String(PERSONAL_GROUP_MAX_MEMBERS)} members.`,
            );
          }
          const members = yield* Effect.forEach(botIds, requireLiveBot);
          const name = input.name.trim().length === 0 ? "New group" : input.name.trim();
          const maxBotTurns = Math.min(
            PERSONAL_GROUP_MAX_BOT_TURNS_CEILING,
            Math.max(1, input.maxBotTurns ?? PERSONAL_GROUP_DEFAULT_MAX_BOT_TURNS),
          );
          // The group thread is created before the rows, so a failed create
          // leaves an orphan thread rather than a group pointing at nothing.
          yield* bots
            .createSharedThread({
              threadId: input.threadId,
              title: GROUP_THREAD_TITLE,
              modelSelection: members[0]!.modelSelection,
            })
            .pipe(
              Effect.mapError((cause) =>
                fail("Personal groups could not create the group chat.", cause),
              ),
            );
          const now = yield* DateTime.now;
          const group: GroupRecord = {
            groupId: input.groupId,
            name,
            description: input.description ?? "",
            threadId: input.threadId,
            maxBotTurns,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          };
          yield* repository.transaction(
            Effect.gen(function* () {
              const inserted = yield* repository.insertGroup(group);
              if (!inserted) {
                return;
              }
              yield* Effect.forEach(
                members,
                (bot, index) =>
                  repository.insertMember({
                    groupId: group.groupId,
                    botId: bot.botId,
                    threadId: null,
                    role: "member",
                    sortOrder: index,
                    deliveredSeq: 0,
                    joinedAt: now,
                    leftAt: null,
                  }),
                { discard: true },
              );
            }),
          );
          groupThreadIds.add(group.threadId);
          return yield* publishGroup(group);
        }),
      )
      .pipe(toPublic("create"));

  const update: PersonalGroupService["Service"]["update"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const now = yield* DateTime.now;
          const next: GroupRecord = {
            ...group,
            ...(input.name === undefined ? {} : { name: input.name.trim() }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.archived === undefined ? {} : { archivedAt: input.archived ? now : null }),
            updatedAt: now,
          };
          yield* repository.writeGroup(next);
          return yield* publishGroup(next);
        }),
      )
      .pipe(toPublic("update"));

  const remove: PersonalGroupService["Service"]["remove"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* repository.getGroup(input.groupId);
          if (Option.isNone(group)) {
            return;
          }
          // Its live rounds end here, under the same permit as the delete. A
          // message sent after an earlier Stop would otherwise leave a running
          // round on a group that no longer exists.
          for (const round of yield* repository.listLiveRounds()) {
            if (round.groupId !== input.groupId) continue;
            yield* interruptActiveTurn(round, "delete");
            yield* abandonActive(group.value, round);
            yield* expirePendingVotes(round);
            yield* writeRound(round, { status: "stopped", queue: [], ...clearActive });
          }
          const now = yield* DateTime.now;
          yield* repository.softDeleteGroup({ groupId: input.groupId, deletedAt: now });
          groupThreadIds.delete(group.value.threadId);
          // Only the shared transcript goes. Member threads are the bots' own
          // chats and keep the history each of them actually lived through.
          yield* dispatchOrLog("delete group thread", {
            type: "thread.delete",
            commandId: CommandId.make(`personal-group:thread.delete:${group.value.threadId}`),
            threadId: group.value.threadId,
          });
        }),
      )
      .pipe(toPublic("delete"));

  const addMember: PersonalGroupService["Service"]["addMember"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const members = yield* repository.listMembers(input.groupId);
          if (members.some((member) => member.botId === input.botId)) {
            return yield* toPublicGroup(group);
          }
          if (members.length >= PERSONAL_GROUP_MAX_MEMBERS) {
            return yield* fail(
              `A group can have at most ${String(PERSONAL_GROUP_MAX_MEMBERS)} members.`,
            );
          }
          const bot = yield* requireLiveBot(input.botId);
          const now = yield* DateTime.now;
          // A member joining mid-conversation starts at the current cursor:
          // it is told what has been said since it joined, not the backlog.
          const deliveredSeq = yield* repository.latestSeq(input.groupId);
          yield* repository.insertMember({
            groupId: input.groupId,
            botId: input.botId,
            threadId: null,
            role: input.role ?? "member",
            sortOrder: members.reduce((max, member) => Math.max(max, member.sortOrder), -1) + 1,
            deliveredSeq,
            joinedAt: now,
            leftAt: null,
          });
          yield* writeSystemRow(group, null, "member-added", `${bot.name} joined the group.`);
          return yield* publishGroup(group);
        }),
      )
      .pipe(toPublic("addMember"));

  const removeMember: PersonalGroupService["Service"]["removeMember"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const members = yield* repository.listMembers(input.groupId);
          if (!members.some((member) => member.botId === input.botId)) {
            return yield* toPublicGroup(group);
          }
          const all = yield* liveBots();
          yield* repository.removeMember({ groupId: input.groupId, botId: input.botId });
          yield* writeSystemRow(
            group,
            null,
            "member-removed",
            `${botName(all, input.botId)} left the group.`,
          );
          const remaining = yield* repository.listMembers(input.groupId);
          if (remaining.length === 0 && group.archivedAt === null) {
            // An empty group is archived, never deleted: the transcript is the
            // record of a conversation that actually happened.
            const now = yield* DateTime.now;
            const archived: GroupRecord = { ...group, archivedAt: now, updatedAt: now };
            yield* repository.writeGroup(archived);
            return yield* publishGroup(archived);
          }
          return yield* publishGroup(group);
        }),
      )
      .pipe(toPublic("removeMember"));

  const sendMessage: PersonalGroupService["Service"]["sendMessage"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const group = yield* requireGroup(input.groupId);
          const members = yield* repository.listMembers(input.groupId);
          if (members.length === 0) {
            return yield* fail("This group has no members left to reply.");
          }
          const existingMessage = yield* repository.getMessageByMessageId(input.messageId);
          const latest = yield* repository.latestRoundForGroup(input.groupId);
          const liveRound = Option.filter(latest, (round) =>
            PersonalGroupRepository.PERSONAL_GROUP_LIVE_ROUND_STATUSES.some(
              (status) => status === round.status,
            ),
          );
          if (Option.isSome(existingMessage)) {
            // A resend of the same client-minted id: never a second round.
            const round =
              existingMessage.value.roundId === null
                ? Option.none<RoundRecord>()
                : yield* repository.getRound(existingMessage.value.roundId);
            if (Option.isSome(round)) {
              return toRound(round.value);
            }
            if (Option.isSome(liveRound)) {
              return toRound(liveRound.value);
            }
            return yield* fail("That message has already been sent to this group.");
          }

          const now = yield* DateTime.now;
          const roundId = Option.isSome(liveRound)
            ? liveRound.value.roundId
            : PersonalGroupRoundId.make(NodeCrypto.randomUUID());
          const row = yield* repository.insertMessage({
            groupId: group.groupId,
            messageId: input.messageId,
            speakerKind: "user",
            speakerBotId: null,
            roundId,
            createdAt: now,
          });
          yield* engine
            .dispatch({
              type: "thread.message.user.append",
              commandId: CommandId.make(`personal-group:${input.messageId}:append`),
              threadId: group.threadId,
              message: {
                messageId: input.messageId,
                text: input.text,
                attachments: [],
                context: personalGroupMessageContext({
                  groupId: group.groupId,
                  seq: row.seq,
                  roundId,
                  speaker: { kind: "user" },
                }),
              },
              createdAt: DateTime.formatIso(now),
            })
            .pipe(
              Effect.mapError((cause) =>
                fail("Personal groups could not post the message.", cause),
              ),
            );

          if (Option.isSome(liveRound)) {
            // One live round per group. The new message is in the transcript,
            // so the next member to speak picks it up in its catch-up rather
            // than racing a second round for the same single slot.
            return toRound(liveRound.value);
          }

          const all = yield* liveBots();
          const mentioned = parseMentions(
            input.text,
            members.map((member) => ({ botId: member.botId, name: botName(all, member.botId) })),
          );
          const addressed = mentioned.filter((botId) =>
            members.some((member) => member.botId === botId),
          );
          const coordinator = members.find((member) => member.role === "coordinator");
          const firstSpeaker = (coordinator ?? members[0]!).botId;
          const discussionOrder = [
            firstSpeaker,
            ...members
              .filter((member) => member.botId !== firstSpeaker)
              .map((member) => member.botId),
          ];
          // One contribution per member, then one reserved synthesis turn.
          // Explicit mentions retain their targeted conversation behavior.
          const broadcast = addressed.length === 0;
          const queue = broadcast ? discussionOrder : addressed;
          const verdictBotId = broadcast && members.length > 1 ? firstSpeaker : null;
          const round: RoundRecord = {
            roundId,
            groupId: group.groupId,
            triggerMessageId: input.messageId,
            verdictBotId,
            status: "running",
            // A broadcast round is sized to the group: every member is queued
            // and the per-member cap lets each take two turns, so a fixed six
            // would pause a six-member discussion halfway through its own
            // plan. A round aimed at named members keeps the frozen rail.
            budgetRemaining: budgetFor({
              frozenMaxBotTurns: group.maxBotTurns,
              memberCount: members.length,
              broadcast,
            }),
            queue,
            spoken: [],
            activeBotId: null,
            activeThreadId: null,
            activeTurnId: null,
            activeMessageId: null,
            relayedChars: 0,
            leaseOwner: null,
            leaseExpiresAt: null,
            availableAt: null,
            // Turns are serial, so the window is the queue's length in turns,
            // plus the reserved verdict, times one provider turn.
            deadlineAt: DateTime.add(now, {
              milliseconds: windowMsFor(queue.length + (verdictBotId === null ? 0 : 1)),
            }),
            errorMessage: null,
            createdAt: now,
            updatedAt: now,
          };
          yield* repository.insertRound(round);
          yield* publishRound(round);
          yield* worker.enqueue({ type: "pump" });
          return toRound(round);
        }),
      )
      .pipe(toPublic("sendMessage"));

  /**
   * The live group turn the calling member is in the middle of, or a refusal.
   * `getRoundByActiveThread` already filters to live rounds, so this single
   * query IS the "outside a group round" check of section V.1 - there is
   * nowhere else a vote could come from.
   */
  const requireSpeakingMember = Effect.fn("PersonalGroupService.requireSpeakingMember")(function* (
    threadId: ThreadId,
    what: string,
  ) {
    const found = yield* repository.getRoundByActiveThread(threadId);
    const nobody = fail(
      `You are not speaking in a group chat right now, so there is nothing to ${what}.`,
    );
    if (Option.isNone(found)) {
      return yield* nobody;
    }
    const round = found.value;
    const botId = round.activeBotId;
    if (botId === null) {
      return yield* nobody;
    }
    const group = yield* requireGroup(round.groupId);
    const members = yield* repository.listMembers(group.groupId);
    if (!members.some((member) => member.botId === botId)) {
      return yield* fail(`You are not a member of '${group.name}'.`);
    }
    return { round, group, members, botId };
  });

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

  const subscribe: PersonalGroupService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(upserts);
      const current = yield* list();
      const replay: Array<PersonalGroupStreamEvent> = [
        ...current.groups.map((group) => ({ type: "group" as const, group })),
        ...current.rounds.map((round) => ({ type: "round" as const, round })),
        ...current.votes.map((vote) => ({ type: "vote" as const, vote })),
      ];
      return Stream.concat(Stream.fromIterable(replay), Stream.fromSubscription(subscription));
    }),
  );

  const changes: PersonalGroupService["Service"]["changes"] = Stream.unwrap(
    Effect.map(PubSub.subscribe(upserts), (subscription) => Stream.fromSubscription(subscription)),
  );

  const start: PersonalGroupService["Service"]["start"] = Effect.fn("PersonalGroupService.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(Stream.runForEach(events, ingestDomainEvent));
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue({ type: "sweep" });
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)), Effect.asVoid),
      );
    },
  );

  return {
    list,
    create,
    update,
    remove,
    addMember,
    removeMember,
    sendMessage,
    continueRound,
    stop,
    subscribe,
    changes,
    start,
    ingestDomainEvent,
    sweep: worker.enqueue({ type: "sweep" }),
    drain: worker.drain,
    callVote,
    castVote,
    groupNameForMemberThread,
    purgeBot,
  } satisfies PersonalGroupService["Service"];
});

export const layer = Layer.effect(PersonalGroupService, make);

/** The service with its own repository; needs SqlClient, bots, engine and projections. */
export const layerLive = layer.pipe(
  Layer.provideMerge(PersonalGroupRepository.layer),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
);
