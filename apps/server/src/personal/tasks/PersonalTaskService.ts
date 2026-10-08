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
import * as Stream from "effect/Stream";
import {
  PersonalTaskId,
  PersonalTaskWorkRecord,
  PersonalTasksError,
  ThreadId,
  type OrchestrationEvent,
  type PersonalBotId,
  type PersonalDelegationBrief,
  type PersonalRoutineNotifyMode,
  type PersonalTask,
  type PersonalTaskCreateInput,
  type PersonalTaskDetail,
  type PersonalTaskHistoryInput,
  type PersonalTaskHistoryResult,
  type PersonalTaskListInput,
  type PersonalTaskListResult,
  type PersonalTaskRelatedInput,
  type PersonalTaskSource,
  type PersonalTaskStreamEvent,
  type TurnId,
} from "@t3tools/contracts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";
import { type WorkRecordPatch } from "./workRecord.ts";
import { withStallJob } from "../../observability/stallJobs.ts";
import { makeTaskCallers } from "./taskCallers.ts";
import { makeTaskCore } from "./taskCore.ts";
import { makeTaskDispatch } from "./taskDispatch.ts";
import { makeTaskLifecycle } from "./taskLifecycle.ts";
import { makeTaskQueries } from "./taskQueries.ts";
import { makeTaskSettling } from "./taskSettling.ts";
import { makeTaskSteering } from "./taskSteering.ts";
import { makeTaskWaiting } from "./taskWaiting.ts";
import { SWEEP_INTERVAL, type WorkItem } from "./taskShared.ts";
import { sessionIsBusy } from "./taskSessionPolicy.ts";

/** Global cap on active provider turns started by the dispatcher. */
export const PERSONAL_TASKS_CONCURRENCY = 5;
export {
  PERSONAL_TASKS_DEFAULT_MAX_CHILDREN,
  PERSONAL_TASKS_DEFAULT_MAX_DEPTH,
  PERSONAL_TASK_TURN_OWNERSHIP_MS,
  personalTaskMessageContext,
} from "./taskShared.ts";

export {
  PERSONAL_TASKS_LIMIT_DETAIL_WAIT_MS,
  PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS,
  PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES,
  PERSONAL_TASKS_RENEWAL_WAIT_MS,
  classifyProviderError,
  providerRetryOfAttempt,
  providerWaitPause,
  type ProviderWaitPause,
} from "./taskLimitPolicy.ts";
export {
  PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS,
  PERSONAL_TASK_BACKGROUND_WAIT_MS,
} from "./taskBackgroundPolicy.ts";
export {
  BACKGROUND_FOLLOW_UP_MARKER,
  PERSONAL_TASK_RESULT_MAX_CHARS,
  TASK_REPLAY_TERMINAL_LIMIT,
  TASK_SUMMARY_RESULT_PREVIEW_CHARS,
  backgroundCapNote,
  composeTaskReplies,
  toTaskSummary,
} from "./taskResultPolicy.ts";
export { FRESH_SESSION_NOTE, reopenNote } from "./taskTurnPolicy.ts";

export interface PersonalTaskCreateOptions extends PersonalTaskCreateInput {
  readonly source?: PersonalTaskSource;
  /**
   * Run in this existing chat instead of a new one. The caller vouches that
   * the chat is the bot's and usable; the dispatcher only waits for it to be
   * idle (no turn running), so the task never interrupts or overlaps a turn.
   */
  readonly threadId?: ThreadId;
  readonly maxDepth?: number;
  readonly maxChildren?: number;
  /**
   * A routine run's notify mode, recorded with the task so the run keeps it
   * even if the routine is edited or removed meanwhile (see notifyDecision.ts).
   */
  readonly notifyMode?: PersonalRoutineNotifyMode;
}

/** A message to post into a new chat of the bot, verbatim, with no model turn. */
export interface PersonalTaskRelayInput {
  /** Same meaning as on createTask: a second relay with this key returns the first task. */
  readonly idempotencyKey: string;
  readonly botId: PersonalBotId;
  /** The task's title, and the new chat's. */
  readonly title: string;
  /** Posted as the bot's message, exactly as given. */
  readonly text: string;
  readonly source?: PersonalTaskSource;
  /** See PersonalTaskCreateOptions.notifyMode. */
  readonly notifyMode?: PersonalRoutineNotifyMode;
}

export interface PersonalTaskDelegateInput {
  readonly parentTaskId: PersonalTaskId;
  readonly targetBotId: PersonalBotId;
  readonly brief: PersonalDelegationBrief;
  /** Defaults to a hash of parent, target and brief, so a retried tool call dedupes. */
  readonly idempotencyKey?: string;
  readonly dependencies?: ReadonlyArray<PersonalTaskId>;
  /**
   * Run the task as a new turn in this existing chat of the target bot (a
   * direct chat between the owner and the bot) instead of a chat of its own,
   * so the bot answers with that conversation in its context. The service
   * checks the chat is the bot's, live and a plain conversation (not a group
   * relay, a task or routine chat), and carries the sensitive-site marks both
   * ways. The task waits for the chat to be idle, like a routine posting into
   * its chat. The chat stays an ordinary chat when the task ends.
   */
  readonly continueThreadId?: ThreadId;
}

export interface PersonalTaskSteerInput {
  readonly taskId: PersonalTaskId;
  /** Who is steering, as the bot reads it: "Update from <fromName>: ...". */
  readonly fromName: string;
  readonly message: string;
  /**
   * The chat the update comes from. What that chat has seen of the sites the
   * user marked sensitive goes with the update into the task's tree, so its
   * work record keeps nothing of it (see `carryExposureToTree`).
   */
  readonly fromThreadId?: ThreadId;
}

/**
 * steered: delivered into the task's running turn, which keeps going.
 * queued: the task is not in a turn now; the update opens its next turn (for
 * a queued task, the brief it starts with).
 * reopened: the task had ended; it is queued again in its own chat and the
 * update opens a continuation turn there.
 */
export interface PersonalTaskSteerResult {
  readonly outcome: "steered" | "queued" | "reopened";
  readonly task: PersonalTask;
  readonly text: string;
}

export interface PersonalTaskSteer {
  readonly text: string;
  readonly createdAt: DateTime.Utc;
  /** Null while it waits for the task's next turn. */
  readonly deliveredAt: DateTime.Utc | null;
}

export class PersonalTaskService extends Context.Service<
  PersonalTaskService,
  {
    readonly createTask: (
      input: PersonalTaskCreateOptions,
    ) => Effect.Effect<PersonalTask, PersonalTasksError>;
    /**
     * Posts `text` into a new chat of the bot as the bot's own message and
     * records a task that is already completed with it as the result, so the
     * run shows in Tasks and notifies exactly like a finished task. No
     * provider turn is started.
     */
    readonly relay: (
      input: PersonalTaskRelayInput,
    ) => Effect.Effect<PersonalTask, PersonalTasksError>;
    readonly delegate: (
      input: PersonalTaskDelegateInput,
    ) => Effect.Effect<PersonalTask, PersonalTasksError>;
    readonly cancel: (input: {
      readonly taskId: PersonalTaskId;
    }) => Effect.Effect<PersonalTask, PersonalTasksError>;
    readonly retry: (input: {
      readonly taskId: PersonalTaskId;
    }) => Effect.Effect<PersonalTask, PersonalTasksError>;
    /**
     * Sends an instruction into an unfinished task without restarting it: a
     * running turn is steered (the bot keeps its context and progress), any
     * other unfinished task gets it at the start of its next turn. A finished
     * task (completed, failed, interrupted, cancelled) is reopened in its own
     * chat with the update as a continuation turn; its result goes back to its
     * parent again, and finished ancestors reopen to receive it (see
     * `reopen`). Recorded on the task either way.
     */
    readonly steer: (
      input: PersonalTaskSteerInput,
    ) => Effect.Effect<PersonalTaskSteerResult, PersonalTasksError>;
    /** Updates sent with `steer`, oldest first. */
    readonly steers: (input: {
      readonly taskId: PersonalTaskId;
    }) => Effect.Effect<ReadonlyArray<PersonalTaskSteer>, PersonalTasksError>;
    readonly get: (input: {
      readonly taskId: PersonalTaskId;
    }) => Effect.Effect<PersonalTaskDetail, PersonalTasksError>;
    /** The task's work record, or null when it has none yet. */
    readonly workRecord: (input: {
      readonly taskId: PersonalTaskId;
    }) => Effect.Effect<PersonalTaskWorkRecord | null, PersonalTasksError>;
    /**
     * A bot's update to its task's work record (decisions and evidence are
     * added, outstanding work and the next step replaced). Refused for a task
     * whose tree had a site the user marked sensitive open: nothing from it is
     * kept.
     */
    readonly updateWorkRecord: (input: {
      readonly taskId: PersonalTaskId;
      readonly patch: WorkRecordPatch;
    }) => Effect.Effect<PersonalTaskWorkRecord, PersonalTasksError>;
    /**
     * The bot's notify_user call for a running task: whether the finished run
     * should notify the user, with an optional one-line message for the push.
     * The last call wins. The caller has already cleaned the message.
     */
    readonly recordNotifyDecision: (input: {
      readonly taskId: PersonalTaskId;
      readonly notify: boolean;
      readonly message: string | null;
    }) => Effect.Effect<PersonalTaskRepository.PersonalTaskNotifyState, PersonalTasksError>;
    /** The task whose active attempt runs in `threadId`, if any. */
    readonly taskForThread: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<Option.Option<PersonalTask>, PersonalTasksError>;
    /**
     * The chat's earlier messages, newest first, for a bot that started a
     * fresh session and needs an exact detail: `query` keeps messages that
     * contain it, `beforeMessageId` pages further back. Each text is clipped.
     */
    readonly chatHistory: (input: {
      readonly threadId: ThreadId;
      readonly query?: string | undefined;
      readonly beforeMessageId?: string | undefined;
      readonly limit: number;
    }) => Effect.Effect<
      {
        readonly messages: ReadonlyArray<{
          readonly messageId: string;
          readonly role: string;
          readonly at: string;
          readonly text: string;
          readonly clipped: boolean;
        }>;
        readonly hasMore: boolean;
      },
      PersonalTasksError
    >;
    readonly list: (
      filter: PersonalTaskListInput,
    ) => Effect.Effect<PersonalTaskListResult, PersonalTasksError>;
    /**
     * Unfinished tasks and the newest finished ones as upserts, then live
     * upserts; all as summaries (see `toTaskSummary`).
     */
    readonly subscribe: Stream.Stream<PersonalTaskStreamEvent, PersonalTasksError>;
    /** Finished tasks older than the ones the feed replays, as summaries. */
    readonly history: (
      input: PersonalTaskHistoryInput,
    ) => Effect.Effect<PersonalTaskHistoryResult, PersonalTasksError>;
    /** A thread's tasks, named tasks, and their children, as summaries. */
    readonly related: (
      input: PersonalTaskRelatedInput,
    ) => Effect.Effect<PersonalTaskListResult, PersonalTasksError>;
    /** Live task changes only, no replay (reactors: memory summaries, push). */
    readonly changes: Stream.Stream<PersonalTask>;
    /** Starts the dispatcher: domain-event watch plus the lease/backoff sweep. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Feeds one orchestration event to the dispatcher (the start() stream uses this). */
    readonly ingestDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
    /** Queues one sweep: heartbeat, expired leases, missed completions, backoff wakeups. */
    readonly sweep: Effect.Effect<void>;
    /** Resolves when every queued dispatcher step has finished. */
    readonly drain: Effect.Effect<void>;
    /**
     * The task a bot's MCP call acts for: the task whose active attempt owns
     * `threadId`, or else a new root task (source "user") that adopts the
     * thread's running turn as its first attempt, so the dispatcher settles
     * it when that turn ends. Idempotent per thread and turn.
     */
    readonly resolveCallerTask: (input: {
      readonly threadId: ThreadId;
      readonly botId: PersonalBotId;
      readonly turnId: TurnId;
    }) => Effect.Effect<PersonalTask, PersonalTasksError>;
    /**
     * Whether a task attempt drives `threadId`'s current turn, or drove the
     * turn that just ended. True for the whole of a task-driven turn and for
     * `PERSONAL_TASK_TURN_OWNERSHIP_MS` after it settles, so a reactor of the
     * same "turn ended" event gets the same answer whichever of the two runs
     * first. A turn this returns true for already earns its own notification
     * from the task stream (or is a delegation the user is not waiting on).
     */
    readonly ownsThreadTurn: (threadId: ThreadId) => Effect.Effect<boolean>;
    /**
     * Takes one of the {@link PERSONAL_TASKS_CONCURRENCY} slots for work that
     * is not a task (a chat continuing after a usage limit reset), so the cap
     * stays one number across both. False when every slot is busy. `key`
     * identifies the holder; taking a slot twice for one key holds one slot.
     */
    readonly reserveExternalSlot: (key: string) => Effect.Effect<boolean>;
    /** Gives a slot from {@link reserveExternalSlot} back; queued tasks may start. */
    readonly releaseExternalSlot: (key: string) => Effect.Effect<void>;
    /** Root of the task tree `threadId` works in: its active task, else its latest task. */
    readonly rootTaskIdForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<PersonalTaskId>, PersonalTasksError>;
    /** Parks a running task until the user acts (the turn's attempt still ends normally). */
    readonly waitForUser: (input: {
      readonly taskId: PersonalTaskId;
    }) => Effect.Effect<PersonalTask, PersonalTasksError>;
    /** Parks a running task until the user finishes an action in the shared browser. */
    readonly waitForBrowser: (input: {
      readonly taskId: PersonalTaskId;
    }) => Effect.Effect<PersonalTask, PersonalTasksError>;
    /**
     * Re-queues a user- or browser-waiting task with `note` as its next turn's
     * opening. `restartSession` first stops the thread's provider session and
     * queues only once it is gone, so the next turn runs in a fresh process.
     */
    readonly resumeFromUser: (input: {
      readonly taskId: PersonalTaskId;
      readonly noteId: string;
      readonly note: string;
      readonly restartSession: boolean;
    }) => Effect.Effect<PersonalTask, PersonalTasksError>;
    /** Fails a waiting_for_user task with `message` and reports it to its parent. */
    readonly failWaitingForUser: (input: {
      readonly taskId: PersonalTaskId;
      readonly message: string;
    }) => Effect.Effect<PersonalTask, PersonalTasksError>;
  }
>()("t3/personal/tasks/PersonalTaskService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const core = yield* makeTaskCore();
  const {
    activeThreadIds,
    engine,
    idleWaitThreadIds,
    lock,
    refreshActiveThreads,
    resumingThreadIds,
    upserts,
  } = core;

  const dispatch = makeTaskDispatch(core, PERSONAL_TASKS_CONCURRENCY);
  const { pump } = dispatch;

  const settling = makeTaskSettling(core, dispatch);
  const { observeSession, resumeWaiting, settle, sweepOnce } = settling;

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
            case "session":
              yield* observeSession(item.threadId, item.session);
              break;
            case "settle":
              yield* settle(item.threadId);
              break;
            case "resume":
              yield* resumeWaiting(item.threadId);
              break;
          }
          yield* pump();
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("personal tasks dispatcher step failed", {
                item: item.type,
                cause: Cause.pretty(cause),
              }),
        ),
      );

  const worker = yield* makeDrainableWorker(processItem);

  yield* refreshActiveThreads().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("personal tasks could not load active attempts", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const ingestDomainEvent: PersonalTaskService["Service"]["ingestDomainEvent"] = (event) => {
    switch (event.type) {
      case "thread.session-set": {
        const threadId = event.payload.threadId;
        // Settle the attempt first, then see whether a waiting task resumes.
        const session = activeThreadIds.has(threadId)
          ? worker.enqueue({ type: "session", threadId, session: event.payload.session })
          : Effect.void;
        const resume = resumingThreadIds.has(threadId)
          ? worker.enqueue({ type: "resume", threadId })
          : Effect.void;
        const idle =
          idleWaitThreadIds.has(threadId) && !sessionIsBusy(event.payload.session)
            ? worker.enqueue({ type: "pump" })
            : Effect.void;
        return Effect.andThen(Effect.andThen(session, resume), idle);
      }
      case "thread.message-sent":
        // Only completed assistant messages: deltas would flood the worker.
        return event.payload.role === "assistant" &&
          !event.payload.streaming &&
          activeThreadIds.has(event.payload.threadId)
          ? worker.enqueue({ type: "settle", threadId: event.payload.threadId })
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const lifecycle = makeTaskLifecycle(core, { worker });
  const { cancel, createTask, delegate, relay, retry } = lifecycle;

  const steering = makeTaskSteering(core, settling, { worker });
  const { steer, steers } = steering;

  const queries = makeTaskQueries(core);
  const {
    chatHistory,
    get,
    history,
    list,
    recordNotifyDecision,
    related,
    subscribe,
    taskForThread,
    updateWorkRecord,
    workRecord,
  } = queries;

  const callers = makeTaskCallers(core, PERSONAL_TASKS_CONCURRENCY, { worker });
  const {
    ownsThreadTurn,
    releaseExternalSlot,
    reserveExternalSlot,
    resolveCallerTask,
    rootTaskIdForThread,
  } = callers;

  const waiting = makeTaskWaiting(core, settling, { worker });
  const { failWaitingForUser, resumeFromUser, waitForBrowser, waitForUser } = waiting;

  const start: PersonalTaskService["Service"]["start"] = Effect.fn("PersonalTaskService.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(Stream.runForEach(events, ingestDomainEvent));
      yield* forkParked(
        Effect.gen(function* () {
          yield* worker.enqueue({ type: "sweep" });
          yield* worker.drain;
        }).pipe(
          withStallJob("job:task-sweep"),
          Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
          Effect.asVoid,
        ),
      );
    },
  );

  const changes: PersonalTaskService["Service"]["changes"] = Stream.unwrap(
    Effect.map(PubSub.subscribe(upserts), (subscription) => Stream.fromSubscription(subscription)),
  );

  return {
    createTask,
    relay,
    delegate,
    cancel,
    retry,
    steer,
    steers,
    get,
    workRecord,
    updateWorkRecord,
    taskForThread,
    recordNotifyDecision,
    chatHistory,
    list,
    subscribe,
    history,
    related,
    changes,
    start,
    ingestDomainEvent,
    sweep: worker.enqueue({ type: "sweep" }),
    drain: worker.drain,
    resolveCallerTask,
    ownsThreadTurn,
    reserveExternalSlot,
    releaseExternalSlot,
    rootTaskIdForThread,
    waitForUser,
    waitForBrowser,
    resumeFromUser,
    failWaitingForUser,
  } satisfies PersonalTaskService["Service"];
});

export const layer = Layer.effect(PersonalTaskService, make);

/** The service with its own repositories; needs SqlClient, bots, engine and projections. */
export const layerLive = layer.pipe(
  Layer.provideMerge(PersonalTaskRepository.layer),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
);
