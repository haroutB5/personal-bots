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

import {
  CommandId,
  ComposerContextId,
  MessageId,
  PERSONAL_GROUP_CATCHUP_MAX_CHARS,
  PERSONAL_GROUP_DEFAULT_MAX_BOT_TURNS,
  PERSONAL_GROUP_MAX_BOT_TURNS_CEILING,
  PERSONAL_GROUP_MAX_MEMBERS,
  PERSONAL_GROUP_MAX_TURNS_PER_MEMBER_PER_ROUND,
  PERSONAL_GROUP_MESSAGE_CONTEXT_KIND,
  PERSONAL_GROUP_ROUND_WALL_CLOCK_MS,
  PersonalGroupId,
  PersonalGroupRoundId,
  PersonalGroupsError,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationMessageContext,
  type OrchestrationSession,
  type PersonalBot,
  type PersonalBotId,
  type PersonalGroup,
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
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { classifyProviderError, providerWaitPause } from "../tasks/PersonalTaskService.ts";
import { parseMentions } from "./groupMentions.ts";
import { admitMentions, nextStep } from "./groupRoundPolicy.ts";
import { buildCatchUpBrief, type GroupCatchUpMessage } from "./groupTurnText.ts";
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
    /** Gives a paused or interrupted round a fresh budget and resumes it. */
    readonly continueRound: (
      input: PersonalGroupIdInput,
    ) => Effect.Effect<PersonalGroupRound, PersonalGroupsError>;
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

/** The group-side message that mirrors one member's reply. */
const replyMessageId = (roundId: PersonalGroupRoundId, turn: number) =>
  MessageId.make(`personal-group-${roundId}-reply-${turn}`);

/** The user-role brief relayed into a member's own thread. */
const briefMessageId = (roundId: PersonalGroupRoundId, turn: number) =>
  MessageId.make(`personal-group-${roundId}-brief-${turn}`);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalGroupRepository.PersonalGroupRepository;
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
  ) {
    const rest = round.queue.slice(1);
    const members = yield* repository.listMembers(group.groupId);
    const member = members.find((entry) => entry.botId === botId);
    const all = yield* liveBots();
    const bot = all.find((entry) => entry.botId === botId);
    if (member === undefined || bot === undefined) {
      // The member left, or its bot was deleted, between queueing and now.
      yield* writeRound(round, { queue: rest });
      return false;
    }
    const now = yield* DateTime.now;
    const threadId = member.threadId ?? ThreadId.make(NodeCrypto.randomUUID());
    yield* bots
      .createThread({ botId, threadId })
      .pipe(
        Effect.mapError((cause) => fail("Personal groups could not open a member chat.", cause)),
      );

    // Catch-up first, cursor second, reservation third: the speaker must not
    // be shown its own pending reply, whose seq is by construction the highest.
    const pending = yield* repository.listMessagesAfter({
      groupId: group.groupId,
      afterSeq: member.deliveredSeq,
    });
    const catchUp: Array<GroupCatchUpMessage> = [];
    for (const entry of pending) {
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
    const replyId = replyMessageId(round.roundId, turn);
    const reserved = yield* repository.insertMessage({
      groupId: group.groupId,
      messageId: replyId,
      speakerKind: "bot",
      speakerBotId: botId,
      roundId: round.roundId,
      createdAt: now,
    });

    const brief = buildCatchUpBrief({
      groupName: group.name,
      speakerName: bot.name,
      otherNames: members
        .filter((entry) => entry.botId !== botId)
        .map((entry) => botName(all, entry.botId)),
      messages: catchUp,
      maxChars: PERSONAL_GROUP_CATCHUP_MAX_CHARS,
    });

    const started = yield* writeRound(round, {
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
    if (note !== null) {
      yield* writeSystemRow(group, round.roundId, note.event, note.text);
    }
    return yield* writeRound(round, {
      status,
      ...clearActive,
      ...(status === "paused_budget" ? {} : { queue: [] }),
    });
  });

  /** Fills the single group slot; one member speaks at a time, server-wide. */
  const pump: Effect.Effect<
    void,
    PersonalGroupsError | PersonalGroupRepository.PersonalGroupRepositoryError
  > = Effect.gen(function* () {
    while (true) {
      const live = yield* repository.listLiveRounds();
      if (live.some((round) => round.activeBotId !== null)) {
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
      const group = yield* requireGroup(round.groupId);
      const verdict = nextStep({
        queue: round.queue,
        spoken: round.spoken,
        budgetRemaining: round.budgetRemaining,
        nowMs,
        deadlineMs: DateTime.toEpochMillis(round.deadlineAt),
      });
      switch (verdict.kind) {
        case "expired":
          yield* endRound(group, round, "interrupted", {
            event: "round-interrupted",
            text: "The group ran out of time before everyone replied.",
          });
          continue;
        case "completed":
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
        case "paused_budget":
          yield* endRound(group, round, "paused_budget", {
            event: "round-paused-budget",
            text: `Paused after ${String(group.maxBotTurns)} replies. Continue to give the group another ${String(group.maxBotTurns)}.`,
          });
          continue;
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
              },
      });
    }
    yield* relayComplete({ group, messageId });

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
    const session: OrchestrationSession | null | undefined = Option.isSome(shell)
      ? shell.value.session
      : null;
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
        yield* endRound(group.value, round, "interrupted", {
          event: "round-interrupted",
          text: "The group ran out of time before everyone replied.",
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
      const rounds = yield* repository.listLiveRounds();
      return {
        groups: published,
        rounds: rounds.map(toRound),
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
          const queue = addressed.length > 0 ? addressed : [(coordinator ?? members[0]!).botId];
          const round: RoundRecord = {
            roundId,
            groupId: group.groupId,
            triggerMessageId: input.messageId,
            status: "running",
            budgetRemaining: group.maxBotTurns,
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
            deadlineAt: DateTime.add(now, { milliseconds: PERSONAL_GROUP_ROUND_WALL_CLOCK_MS }),
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
          const resumed = yield* writeRound(round, {
            status: "running",
            // A fresh budget, deliberately: Continue is the user saying the
            // conversation is worth another `maxBotTurns` replies.
            budgetRemaining: group.maxBotTurns,
            deadlineAt: DateTime.add(now, { milliseconds: PERSONAL_GROUP_ROUND_WALL_CLOCK_MS }),
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
