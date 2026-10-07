import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  PersonalGroupsError,
  PersonalGroupVoteId,
  ThreadId,
  type OrchestrationEvent,
  type PersonalBotId,
  type PersonalGroup,
  type PersonalGroupContinueRoundInput,
  type PersonalGroupCreateInput,
  type PersonalGroupIdInput,
  type PersonalGroupListResult,
  type PersonalGroupMemberInput,
  type PersonalGroupRound,
  type PersonalGroupSendMessageInput,
  type PersonalGroupStreamEvent,
  type PersonalGroupUpdateInput,
  type PersonalGroupVote,
} from "@t3tools/contracts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalGroupRepository from "./PersonalGroupRepository.ts";
import { withStallJob } from "../../observability/stallJobs.ts";
import { SWEEP_INTERVAL, type WorkItem } from "./groupShared.ts";
import { makeGroupControl } from "./groupControl.ts";
import { makeGroupCore } from "./groupCore.ts";
import { makeGroupFinish } from "./groupFinish.ts";
import { makeGroupManagement } from "./groupManagement.ts";
import { makeGroupMessaging } from "./groupMessaging.ts";
import { makeGroupSettling } from "./groupSettling.ts";
import { makeGroupTurns } from "./groupTurns.ts";
import { makeGroupVoting } from "./groupVoting.ts";
import { makeGroupVotes } from "./groupVotes.ts";
export { personalGroupMessageContext } from "./groupShared.ts";

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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const core = yield* makeGroupCore();
  const { activeMemberThreadIds, engine, groupThreadIds, lock, refreshCaches, upserts } = core;

  const votes = makeGroupVotes(core);
  const turns = makeGroupTurns(core, votes);
  const { pump } = turns;

  const finish = makeGroupFinish(core, turns);
  const settling = makeGroupSettling(core, votes, turns, finish);
  const { relayFromMember, settleActive, stopStrayTurn, sweepOnce } = settling;

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

  const management = makeGroupManagement(core, votes, turns);
  const { addMember, create, list, remove, removeMember, update } = management;

  const messaging = makeGroupMessaging(core, { worker });
  const { sendMessage } = messaging;

  const voting = makeGroupVoting(core, votes, turns, messaging, { worker });
  const { callVote, castVote } = voting;

  const control = makeGroupControl(core, votes, turns, voting, { worker });
  const { continueRound, groupNameForMemberThread, purgeBot, stop } = control;

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
        }).pipe(
          withStallJob("job:group-sweep"),
          Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
          Effect.asVoid,
        ),
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
