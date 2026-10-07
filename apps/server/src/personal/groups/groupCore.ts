// @effect-diagnostics nodeBuiltinImport:off - same node access as PersonalGroupService.ts.
// The group service's shared parts: its dependencies, the dispatcher's state and the helpers every part uses
// (groups and rounds as the wire shows them, the transcript rows and the relay into the group thread).
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  MessageId,
  withPersonalReplyQuote,
  PersonalGroupId,
  PersonalGroupRoundId,
  PersonalGroupsError,
  type PersonalBot,
  type PersonalBotId,
  type PersonalGroup,
  type PersonalGroupMessageMarker,
  type PersonalGroupRound,
  type PersonalGroupStreamEvent,
  type PersonalGroupSystemEvent,
  type PersonalGroupVote,
} from "@t3tools/contracts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { makeSensitiveExposureStore } from "../browser/sensitiveExposureStore.ts";
import { makeGroupLimitResumeStore } from "./groupLimitResumes.ts";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";
import { type GroupRecord, type RoundRecord, personalGroupMessageContext } from "./groupShared.ts";

export const makeGroupCore = () =>
  Effect.gen(function* () {
    const repository = yield* PersonalGroupRepository.PersonalGroupRepository;
    // The sensitive-site taint travels with the transcript: a member's reply
    // carries its thread's taint into the group, and the group's taint rides the
    // catch-up brief into the next speaker's thread (audit K2).
    const sqlClient = yield* SqlClient.SqlClient;
    const exposures = makeSensitiveExposureStore(sqlClient);
    const limitResumes = makeGroupLimitResumeStore(sqlClient);
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
    /**
     * The last usage-limit wait a member's running session reported, by thread.
     * A wait shorter than the long-wait threshold is left to the provider, and
     * the error that ends the turn often arrives without its reset time (the
     * time rides on the session event just before it): this keeps it.
     */
    const reportedWaits = new Map<
      string,
      { readonly retryAt: string; readonly provider: string; readonly reason: string | undefined }
    >();

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
        // A reply's quote goes in front of its text, as a model reads it in a bot chat.
        Effect.map((row) =>
          Option.isSome(row) ? withPersonalReplyQuote(row.value.text, row.value.context) : "",
        ),
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
        ...(group.pinnedAt == null ? {} : { pinnedAt: group.pinnedAt }),
        ...(group.snoozedUntil == null ? {} : { snoozedUntil: group.snoozedUntil }),
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
      // The list preview of a group never carries a hidden bot's words (the
      // owner's "Hide message previews" switch): not the bot's own message, and
      // not any bot message of a group it is a member of, since a bot's reply or
      // the verdict can quote another member. The user's own messages and system
      // rows are not bot text and keep showing.
      const hiddenIds = new Set(
        (yield* liveBots()).filter((bot) => bot.hidePreviews === true).map((bot) => bot.botId),
      );
      const hideText =
        newest.speakerKind === "bot" &&
        ((newest.speakerBotId !== null && hiddenIds.has(newest.speakerBotId)) ||
          members.some((member) => member.leftAt === null && hiddenIds.has(member.botId)));
      return {
        ...base,
        newestMessage: Option.isNone(row)
          ? null
          : {
              id: row.value.messageId,
              role: row.value.role,
              text: hideText ? "" : row.value.text,
              ...(row.value.context === undefined || hideText
                ? {}
                : { context: row.value.context }),
              ...(hideText ? { hidden: true } : {}),
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
        commandId: CommandId.make(
          `personal-group:${input.messageId}:delta:${String(input.offset)}`,
        ),
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

    const publishVote = (vote: PersonalGroupVote) =>
      PubSub.publish(upserts, { type: "vote", vote });

    return {
      activeMemberThreadIds,
      botName,
      botRepository,
      bots,
      carryTaint,
      dispatchOrLog,
      engine,
      fail,
      groupThreadIds,
      leaseOwner,
      limitResumes,
      liveBots,
      lock,
      messages,
      publishGroup,
      publishRound,
      publishVote,
      readMessageText,
      refreshCaches,
      relayComplete,
      relayDelta,
      reportedWaits,
      repository,
      requireGroup,
      requireLiveBot,
      snapshots,
      throttles,
      toPublic,
      toPublicGroup,
      toRound,
      upserts,
      writeSystemRow,
    };
  });

export type GroupCore = Effect.Success<ReturnType<typeof makeGroupCore>>;
