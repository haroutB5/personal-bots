import * as NodeCrypto from "node:crypto";

import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
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
  PERSONAL_TASK_MESSAGE_CONTEXT_KIND,
  PERSONAL_TASK_RETRYABLE_STATUSES,
  PERSONAL_TASK_TERMINAL_STATUSES,
  PersonalTaskId,
  PersonalTasksError,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationMessageContext,
  type OrchestrationSession,
  type PersonalBotId,
  type PersonalDelegationBrief,
  type PersonalHandoff,
  type PersonalTask,
  type PersonalTaskAttempt,
  type PersonalTaskCreateInput,
  type PersonalTaskDetail,
  type PersonalTaskHistoryInput,
  type PersonalTaskHistoryResult,
  type PersonalTaskListInput,
  type PersonalTaskListResult,
  type PersonalTaskMessageMarker,
  type PersonalTaskRelatedInput,
  type PersonalTaskSource,
  type PersonalTaskStatus,
  type PersonalTaskStreamEvent,
  type TurnId,
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import { botModelSelectionForThread } from "../botModelSelection.ts";
import {
  personalTaskMessageId,
  personalTaskSteerMessageId,
  personalTaskThreadTitle,
} from "../personalThreadTitles.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";
import { serverPerfOptimizationOn } from "../perfFlags.ts";

/** Global cap on active provider turns started by the dispatcher. */
export const PERSONAL_TASKS_CONCURRENCY = 2;
export const PERSONAL_TASKS_DEFAULT_MAX_DEPTH = 2;
export const PERSONAL_TASKS_DEFAULT_MAX_CHILDREN = 4;
/** Backoff before each rate-limited re-run; one more rate limit fails the task. */
export const PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES = [1, 5, 15] as const;
const LEASE_MINUTES = 2;
/**
 * How long after an attempt settles its thread still counts as task-driven.
 * Only has to outlast the gap between two reactors of the same domain event,
 * so seconds are plenty; it is deliberately short so an ordinary chat turn
 * right after a task finishes still notifies.
 */
export const PERSONAL_TASK_TURN_OWNERSHIP_MS = 30_000;
const SWEEP_INTERVAL = "30 seconds";

/**
 * How long a Claude task stays running after its latest turn ends while
 * background work that turn left (a Bash run with run_in_background, a
 * background subagent, a Monitor) is still live. Claude Code starts a new
 * turn in the same session when that work finishes, and that turn's reply is
 * the task's result. Work that never ends (a dev server) closes the task
 * with its latest reply and a note once no turn has run for this long.
 */
export const PERSONAL_TASK_BACKGROUND_WAIT_MS = 20 * 60_000;
/**
 * Once the background work has ended, how long to wait for the turn Claude
 * Code starts to report it before the latest reply stands as the result.
 */
export const PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS = 60_000;
/** Only Claude sessions run a new turn of their own when background work ends. */
const BACKGROUND_WAIT_PROVIDER = "claudeAgent";

const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|\b429\b|\b529\b|overloaded|quota|usage limit|provider.{0,40}unavailable|service unavailable|\b503\b/i;

/** Rate limits and an unreachable provider back off; anything else fails the attempt. */
export const classifyProviderError = (message: string | null): "rate_limited" | "provider_error" =>
  message !== null && RATE_LIMIT_PATTERN.test(message) ? "rate_limited" : "provider_error";

/** A provider wait longer than this gives the task's slot back instead of holding it. */
export const PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS = 2 * 60_000;

export interface ProviderWaitPause {
  readonly retry: NonNullable<OrchestrationSession["providerRetry"]>;
  /** The provider's reported next attempt / reset; null = not reported (use the backoff). */
  readonly retryAtMs: number | null;
}

/**
 * Whether a running task turn should stop waiting on its provider. A reported
 * wait (rate limit or retry) pauses when it is more than two minutes out; a
 * rate limit that reports no reset always pauses. Short retries are left to
 * the provider.
 */
export const providerWaitPause = (
  retry: OrchestrationSession["providerRetry"],
  nowMs: number,
): ProviderWaitPause | null => {
  if (retry === undefined) return null;
  const retryAtMs = retry.retryAt === undefined ? Number.NaN : Date.parse(retry.retryAt);
  if (!Number.isFinite(retryAtMs)) {
    return retry.kind === "rate_limited" ? { retry, retryAtMs: null } : null;
  }
  return retryAtMs - nowMs > PERSONAL_TASKS_LONG_PROVIDER_WAIT_MS ? { retry, retryAtMs } : null;
};

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
}

export interface PersonalTaskDelegateInput {
  readonly parentTaskId: PersonalTaskId;
  readonly targetBotId: PersonalBotId;
  readonly brief: PersonalDelegationBrief;
  /** Defaults to a hash of parent, target and brief, so a retried tool call dedupes. */
  readonly idempotencyKey?: string;
  readonly dependencies?: ReadonlyArray<PersonalTaskId>;
}

export interface PersonalTaskSteerInput {
  readonly taskId: PersonalTaskId;
  /** Who is steering, as the bot reads it: "Update from <fromName>: ...". */
  readonly fromName: string;
  readonly message: string;
}

/**
 * steered: delivered into the task's running turn, which keeps going.
 * queued: the task is not in a turn now; the update opens its next turn (for
 * a queued task, the brief it starts with).
 */
export interface PersonalTaskSteerResult {
  readonly outcome: "steered" | "queued";
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
     * other unfinished task gets it at the start of its next turn. Recorded
     * on the task either way; a finished task is refused.
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

type Changed = Array<PersonalTask>;

type AttemptOutcome =
  | { readonly kind: "completed"; readonly summary: string }
  | { readonly kind: "interrupted"; readonly message: string | null }
  | {
      readonly kind: "failed";
      readonly category: "rate_limited" | "provider_error" | "dispatch_failed";
      readonly message: string | null;
      /** A reset the provider reported; replaces the 1/5/15 min backoff. */
      readonly availableAt?: DateTime.Utc;
    };

type WorkItem =
  | { readonly type: "pump" }
  | { readonly type: "sweep" }
  | {
      readonly type: "session";
      readonly threadId: ThreadId;
      readonly session: OrchestrationSession;
    }
  | { readonly type: "settle"; readonly threadId: ThreadId }
  | { readonly type: "resume"; readonly threadId: ThreadId };

/** What an active attempt knows about the background work in its chat. */
interface BackgroundWait {
  readonly attemptKey: string;
  /** Tasks already live when the attempt started; never waited for. */
  readonly baseline: ReadonlySet<string>;
  /** `updatedAt` of the last ended turn that left work running; null = never. */
  pendingReadyAt: string | null;
  /** Since when nothing has run while that work stayed live, epoch ms. */
  idleSinceMs: number;
  /** When the work was first seen ended with no newer turn after it, epoch ms. */
  clearedAtMs: number | null;
}

const backgroundAttemptKey = (attempt: PersonalTaskAttempt) =>
  `${attempt.taskId}:${attempt.attempt}`;

/** Added to the result of a task closed by the background-work cap. */
export const backgroundCapNote = (count: number) =>
  `(Closed by the task runner: ${count === 1 ? "a background command" : `${count} background commands`} the bot started ${count === 1 ? "was" : "were"} still running ${Math.round(PERSONAL_TASK_BACKGROUND_WAIT_MS / 60_000)} minutes after this reply. Anything the bot reports later is in its chat, not here.)`;

const BACKGROUND_SESSION_ENDED_NOTE =
  "(Closed by the task runner: the bot's session ended while background work it started was still running.)";

const withNote = (summary: string, note: string) =>
  note.length === 0 ? summary : summary.length === 0 ? note : `${summary}\n\n${note}`;

/** A session in the middle of a turn: a queued task for its thread waits. */
const sessionIsBusy = (session: OrchestrationSession | null | undefined) =>
  session?.status === "running" || session?.status === "starting";

/** A session that still has a provider process behind it. */
const sessionIsAlive = (session: OrchestrationSession | null | undefined) =>
  session !== null &&
  session !== undefined &&
  session.status !== "stopped" &&
  session.status !== "error";

const isTerminal = (status: PersonalTaskStatus) => PERSONAL_TASK_TERMINAL_STATUSES.includes(status);

/**
 * Finished tasks replayed to a new subscriber; older ones come from
 * `history` and `related`. 200 with the task-summaries kill switch on,
 * which is what every client got before summaries.
 */
export const TASK_REPLAY_TERMINAL_LIMIT = 20;
const TASK_REPLAY_TERMINAL_LIMIT_FULL = 200;

/** Longest result preview a summary carries; the delegation card shows 4 lines. */
export const TASK_SUMMARY_RESULT_PREVIEW_CHARS = 600;

const TASK_HISTORY_DEFAULT_LIMIT = 20;
const TASK_HISTORY_MAX_LIMIT = 100;
const TASK_RELATED_MAX_IDS = 100;

/**
 * What lists and the live feed send: the task without its long text. The
 * objective and acceptance/expected-output bodies are blank and the result is
 * a preview; `personalTasks.get` has everything. Opening the app used to
 * download every task's full text (641 KB for 150 tasks).
 */
export const toTaskSummary = (task: PersonalTask): PersonalTask => {
  const summary = task.result?.summary;
  const preview =
    summary === undefined || summary.length <= TASK_SUMMARY_RESULT_PREVIEW_CHARS
      ? summary
      : `${summary.slice(0, TASK_SUMMARY_RESULT_PREVIEW_CHARS).trimEnd()}…`;
  return {
    ...task,
    objective: "",
    acceptanceCriteria: "",
    expectedOutput: "",
    result: preview === undefined ? null : { summary: preview },
    detailOmitted: true,
  };
};

const minutesFrom = (now: DateTime.Utc, minutes: number) => DateTime.add(now, { minutes });

/** The user message that starts an attempt's turn; deterministic so a re-dispatch dedupes. */
const attemptMessageId = (attempt: PersonalTaskAttempt) =>
  personalTaskMessageId(attempt.taskId, attempt.attempt);

const sourceLabel = (task: PersonalTask, delegatorName: string | null) => {
  switch (task.source) {
    case "user":
      return "[Task from you]";
    case "routine":
      return "[Routine task]";
    case "delegation":
      return `[Delegated task from ${delegatorName ?? "another bot"}]`;
  }
};

const taskSections = (task: PersonalTask, brief: PersonalDelegationBrief | null) =>
  [
    `Task id: ${task.taskId}`,
    `Title: ${task.title}`,
    `Objective:\n${task.objective}`,
    brief?.context ? `Context:\n${brief.context}` : null,
    brief?.constraints ? `Constraints:\n${brief.constraints}` : null,
    task.acceptanceCriteria ? `Acceptance criteria:\n${task.acceptanceCriteria}` : null,
    task.expectedOutput ? `Expected output:\n${task.expectedOutput}` : null,
  ].filter((section) => section !== null);

/**
 * The message context that marks a task turn as server-authored. The record is
 * never referenced from the text, so `projectComposerContextForProvider` drops
 * it and the provider prompt is unchanged.
 */
export const personalTaskMessageContext = (
  marker: PersonalTaskMessageMarker,
): OrchestrationMessageContext => ({
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make(PERSONAL_TASK_MESSAGE_CONTEXT_KIND),
      label: "Task turn",
      kind: PERSONAL_TASK_MESSAGE_CONTEXT_KIND,
      payload: marker,
    },
  ],
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
  const botRepository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const messages = yield* ProjectionThreadMessageRepository;
  const liveness = yield* ThreadBackgroundLiveness.ThreadBackgroundLivenessService;

  // One owner per server process: a lease held by anyone else and past its
  // expiry belongs to a process that died mid-turn.
  const leaseOwner = `personal-tasks:${NodeCrypto.randomUUID()}`;
  const upserts = yield* PubSub.unbounded<PersonalTask>();
  // Serialises public mutations with dispatcher steps, so a claim never
  // interleaves with a cancel or a delegation on the same rows.
  const lock = yield* Semaphore.make(1);
  // Provider threads with an active attempt; filters the hot event stream.
  const activeThreadIds = new Set<string>();
  // Threads whose waiting task queues once their provider session is gone.
  const resumingThreadIds = new Set<string>();
  // Threads with a queued task held back because a turn (usually the user's
  // own chat turn) is running there; their next session change re-pumps.
  const idleWaitThreadIds = new Set<string>();
  /**
   * When a thread's attempt last stopped owning it, in epoch ms. Read together
   * with `activeThreadIds` by `ownsThreadTurn`, so that question is answered
   * the same way before and after the attempt settles. Another reactor of the
   * same domain event can then decide without racing this one.
   */
  const settledThreadAtMs = new Map<string, number>();
  /**
   * Background work per provider thread with an active attempt. Held in
   * memory like the liveness registry it reads: after a restart that registry
   * is empty and the attempt is closed by its expired lease anyway.
   */
  const backgroundByThread = new Map<string, BackgroundWait>();

  const releaseThread = (threadId: string, nowMs: number) => {
    activeThreadIds.delete(threadId);
    backgroundByThread.delete(threadId);
    settledThreadAtMs.set(threadId, nowMs);
  };

  const fail = (message: string, cause?: unknown) =>
    new PersonalTasksError({ message, ...(cause === undefined ? {} : { cause }) });

  const toPublic =
    (operation: string) =>
    <A, R>(
      effect: Effect.Effect<
        A,
        PersonalTasksError | PersonalTaskRepository.PersonalTaskRepositoryError,
        R
      >,
    ) =>
      effect.pipe(
        Effect.mapError((error) =>
          error._tag === "PersonalTasksError"
            ? error
            : fail(`Personal tasks ${operation} failed.`, error),
        ),
      );

  const publish = (changed: Changed) => {
    const latest = new Map<string, PersonalTask>();
    for (const task of changed) {
      latest.set(task.taskId, task);
    }
    return Effect.forEach(latest.values(), (task) => PubSub.publish(upserts, task), {
      discard: true,
    });
  };

  const refreshActiveThreads = Effect.fn("PersonalTaskService.refreshActiveThreads")(function* () {
    const active = yield* repository.listActiveAttempts();
    activeThreadIds.clear();
    for (const attempt of active) {
      activeThreadIds.add(attempt.providerThreadId);
    }
    return active;
  });

  const requireTask = Effect.fn("PersonalTaskService.requireTask")(function* (
    taskId: PersonalTaskId,
  ) {
    const task = yield* repository.getTask(taskId);
    if (Option.isNone(task)) {
      return yield* fail(`Personal task '${taskId}' was not found.`);
    }
    return task.value;
  });

  const requireLiveBot = Effect.fn("PersonalTaskService.requireLiveBot")(function* (
    botId: PersonalBotId,
  ) {
    const live = yield* botRepository
      .listBots()
      .pipe(Effect.mapError((cause) => fail("Personal tasks bot lookup failed.", cause)));
    const bot = live.find((entry) => entry.botId === botId);
    if (bot === undefined) {
      return yield* fail(`Personal bot '${botId}' was not found.`);
    }
    return bot;
  });

  /** Writes `patch` while the row still has the status `task` was read with. */
  const writeTask = Effect.fn("PersonalTaskService.writeTask")(function* (
    changed: Changed,
    task: PersonalTask,
    patch: Partial<PersonalTask>,
  ) {
    const next: PersonalTask = { ...task, ...patch, updatedAt: yield* DateTime.now };
    const written = yield* repository.writeTask(next, task.status);
    if (!written) {
      return null;
    }
    changed.push(next);
    return next;
  });

  // A parent continues once, after ALL its children are terminal, with every
  // child result in one continuation turn. The status guard makes the wake
  // idempotent: a duplicate completion finds the parent already queued.
  const wakeParent = Effect.fn("PersonalTaskService.wakeParent")(function* (
    changed: Changed,
    parentTaskId: PersonalTaskId,
  ) {
    const parent = yield* repository.getTask(parentTaskId);
    if (Option.isNone(parent) || parent.value.status !== "waiting_for_agent") {
      return;
    }
    const handoffs = yield* repository.listHandoffsByParent(parentTaskId);
    if (handoffs.some((handoff) => handoff.status === "pending")) {
      return;
    }
    if (!handoffs.some((handoff) => handoff.status === "returned")) {
      return;
    }
    yield* writeTask(changed, parent.value, { status: "queued" });
  });

  /** Hands a terminal child's outcome to its parent's handoff row. */
  const returnToParent = Effect.fn("PersonalTaskService.returnToParent")(function* (
    changed: Changed,
    child: PersonalTask,
  ) {
    const handoff = yield* repository.getHandoffByChild(child.taskId);
    if (Option.isNone(handoff) || handoff.value.status !== "pending") {
      return;
    }
    const summary =
      child.status === "completed"
        ? (child.result?.summary ?? "")
        : `Task ${child.status}${child.errorMessage ? `: ${child.errorMessage}` : "."}`;
    yield* repository.writeHandoff({
      ...handoff.value,
      status: "returned",
      resultSummary: summary,
      updatedAt: yield* DateTime.now,
    });
    yield* wakeParent(changed, handoff.value.parentTaskId);
  });

  // A turn that ended cleanly: open children park the task (releasing its
  // slot, since the attempt has ended), returned-but-undelivered results
  // queue a continuation, and otherwise the task is done.
  const resolveAfterTurn = Effect.fn("PersonalTaskService.resolveAfterTurn")(function* (
    changed: Changed,
    task: PersonalTask,
    summary: string,
  ) {
    const handoffs = yield* repository.listHandoffsByParent(task.taskId);
    if (handoffs.some((handoff) => handoff.status === "pending")) {
      yield* writeTask(changed, task, { status: "waiting_for_agent" });
      return;
    }
    if (handoffs.some((handoff) => handoff.status === "returned")) {
      yield* writeTask(changed, task, { status: "queued" });
      return;
    }
    const completed = yield* writeTask(changed, task, {
      status: "completed",
      result: { summary },
      errorCategory: null,
      errorMessage: null,
      completedAt: yield* DateTime.now,
    });
    if (completed !== null) {
      yield* returnToParent(changed, completed);
    }
  });

  const finishAttempt = Effect.fn("PersonalTaskService.finishAttempt")(function* (
    attempt: PersonalTaskAttempt,
    outcome: AttemptOutcome,
  ) {
    const changed: Changed = [];
    yield* repository.transaction(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const category =
          outcome.kind === "completed"
            ? null
            : outcome.kind === "interrupted"
              ? "interrupted"
              : outcome.category;
        yield* repository.writeAttempt({
          ...attempt,
          endedAt: now,
          errorCategory: category,
          resumable: category === "interrupted" || category === "rate_limited",
        });
        const task = yield* repository.getTask(attempt.taskId);
        if (Option.isNone(task) || task.value.status !== "running") {
          return;
        }
        if (outcome.kind === "completed") {
          yield* resolveAfterTurn(changed, task.value, outcome.summary);
          return;
        }
        if (outcome.kind === "failed" && outcome.category === "rate_limited") {
          // A reported reset is honest about the wait, so it is used as-is
          // rather than spending the unreported-limit backoff budget.
          if (
            outcome.availableAt !== undefined &&
            DateTime.toEpochMillis(outcome.availableAt) > DateTime.toEpochMillis(now)
          ) {
            yield* writeTask(changed, task.value, {
              status: "rate_limited",
              availableAt: outcome.availableAt,
              errorCategory: "rate_limited",
              errorMessage: outcome.message,
            });
            return;
          }
          const attempts = yield* repository.listAttempts(attempt.taskId);
          let consecutive = 0;
          for (const entry of attempts.toReversed()) {
            if (entry.errorCategory !== "rate_limited") break;
            consecutive += 1;
          }
          const backoff = PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES[consecutive - 1];
          if (backoff !== undefined) {
            yield* writeTask(changed, task.value, {
              status: "rate_limited",
              availableAt: minutesFrom(now, backoff),
              errorCategory: "rate_limited",
              errorMessage: outcome.message,
            });
            return;
          }
        }
        const ended = yield* writeTask(changed, task.value, {
          status: outcome.kind === "interrupted" ? "interrupted" : "failed",
          errorCategory: category,
          errorMessage: outcome.message,
          completedAt: now,
        });
        if (ended !== null) {
          yield* returnToParent(changed, ended);
        }
      }),
    );
    releaseThread(attempt.providerThreadId, DateTime.toEpochMillis(yield* DateTime.now));
    yield* publish(changed);
  });

  const buildTurnText = Effect.fn("PersonalTaskService.buildTurnText")(function* (
    task: PersonalTask,
    attemptNumber: number,
    delivered: ReadonlyArray<PersonalHandoff>,
    notes: ReadonlyArray<string>,
  ) {
    const marker = (
      turn: PersonalTaskMessageMarker["turn"],
      delegatorBotId: PersonalBotId | null,
      children: PersonalTaskMessageMarker["children"],
    ): PersonalTaskMessageMarker => ({
      taskId: task.taskId,
      attempt: attemptNumber,
      turn,
      source: task.source,
      title: task.title,
      delegatorBotId,
      children,
    });
    if (delivered.length > 0) {
      const results = yield* Effect.forEach(delivered, (handoff) =>
        repository.getTask(handoff.childTaskId).pipe(
          Effect.map((child) => ({
            text: `### ${handoff.brief.title} (${Option.match(child, {
              onNone: () => "unknown",
              onSome: (value) => value.status,
            })})\n${handoff.resultSummary ?? ""}`,
            child: {
              taskId: handoff.childTaskId,
              botId: Option.isSome(child) ? child.value.botId : null,
              title: handoff.brief.title,
              status: Option.isSome(child) ? child.value.status : null,
            },
          })),
        ),
      );
      return {
        text: [
          "[Task continuation] Your delegated tasks have finished. Their results:",
          ...results.map((result) => result.text),
          ...notes,
          "Continue the task below with these results and give your final answer.",
          ...taskSections(task, null),
        ].join("\n\n"),
        marker: marker(
          "continuation",
          null,
          results.map((result) => result.child),
        ),
      };
    }
    // Notes before a task's first turn can only be updates sent while it was
    // queued: it starts with its full brief, updates after it.
    if (notes.length > 0 && attemptNumber > 1) {
      return {
        text: [
          "[Task continuation]",
          ...notes,
          "Continue the task below.",
          ...taskSections(task, null),
        ].join("\n\n"),
        marker: marker("continuation", null, []),
      };
    }
    const handoff = yield* repository.getHandoffByChild(task.taskId);
    let delegatorName: string | null = null;
    let delegatorBotId: PersonalBotId | null = null;
    if (Option.isSome(handoff)) {
      const parent = yield* repository.getTask(handoff.value.parentTaskId);
      if (Option.isSome(parent)) {
        delegatorBotId = parent.value.botId;
        const bot = yield* botRepository
          .getBotById({ botId: parent.value.botId })
          .pipe(Effect.orElseSucceed(() => Option.none()));
        delegatorName = Option.isSome(bot) ? bot.value.name : null;
      }
    }
    const header =
      attemptNumber > 1
        ? `${sourceLabel(task, delegatorName)} Retry, attempt ${attemptNumber}.`
        : sourceLabel(task, delegatorName);
    return {
      text: [
        header,
        ...taskSections(task, Option.isSome(handoff) ? handoff.value.brief : null),
        ...(notes.length > 0
          ? [`Updates since this task was handed over:\n\n${notes.join("\n\n")}`]
          : []),
      ].join("\n\n"),
      marker: marker(attemptNumber > 1 ? "retry" : "start", delegatorBotId, []),
    };
  });

  // Creates the bot thread on first use and starts the turn. Deterministic
  // command and message ids make a repeated start of one attempt dedupe on
  // the orchestration command receipt.
  const startTurn = Effect.fn("PersonalTaskService.startTurn")(function* (
    task: PersonalTask,
    attempt: PersonalTaskAttempt,
    delivered: ReadonlyArray<PersonalHandoff>,
    notes: ReadonlyArray<string>,
  ) {
    const { text, marker } = yield* buildTurnText(task, attempt.attempt, delivered, notes);
    // A chat made for this task (or routine run) is named after it. A task
    // bound to an existing chat (a routine posting into the chat it was made
    // in, or a retry) finds the thread there and leaves its title alone.
    yield* bots.createThread({
      botId: task.botId,
      threadId: attempt.providerThreadId,
      title: personalTaskThreadTitle(task.title),
    });
    // The bot's current model and options (reasoning effort above all); a
    // turn without them runs at the provider's defaults.
    const thread = yield* snapshots
      .getThreadShellById(attempt.providerThreadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const modelSelection = yield* botModelSelectionForThread(
      botRepository,
      attempt.providerThreadId,
      Option.isSome(thread) ? thread.value.modelSelection : undefined,
    );
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`personal-task:${task.taskId}:${attempt.attempt}:turn.start`),
      threadId: attempt.providerThreadId,
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      message: {
        messageId: attemptMessageId(attempt),
        role: "user",
        text,
        attachments: [],
        context: personalTaskMessageContext(marker),
      },
      titleSeed: task.title,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const claim = Effect.fn("PersonalTaskService.claim")(function* (task: PersonalTask) {
    const changed: Changed = [];
    const claimed = yield* repository.transaction(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const threadId = task.threadId ?? ThreadId.make(NodeCrypto.randomUUID());
        const running = yield* writeTask(changed, task, {
          status: "running",
          threadId,
          startedAt: task.startedAt ?? now,
          availableAt: null,
          completedAt: null,
          errorCategory: null,
          errorMessage: null,
        });
        if (running === null) {
          return null;
        }
        const previous = yield* repository.listAttempts(task.taskId);
        const attempt: PersonalTaskAttempt = {
          taskId: task.taskId,
          attempt: (previous.at(-1)?.attempt ?? 0) + 1,
          providerThreadId: threadId,
          turnId: null,
          leaseOwner,
          leaseExpiresAt: minutesFrom(now, LEASE_MINUTES),
          heartbeatAt: now,
          startedAt: now,
          endedAt: null,
          errorCategory: null,
          resumable: false,
        };
        yield* repository.insertAttempt(attempt);
        const handoffs = yield* repository.listHandoffsByParent(task.taskId);
        const delivered = handoffs.filter((handoff) => handoff.status === "returned");
        yield* Effect.forEach(
          delivered,
          (handoff) => repository.writeHandoff({ ...handoff, status: "delivered", updatedAt: now }),
          { discard: true },
        );
        const notes = yield* repository.listUndeliveredNotes(task.taskId);
        if (notes.length > 0) {
          yield* repository.markNotesDelivered(task.taskId, now);
        }
        return { task: running, attempt, delivered, notes: notes.map((note) => note.text) };
      }),
    );
    if (claimed !== null) {
      const threadId = claimed.attempt.providerThreadId;
      activeThreadIds.add(threadId);
      // Work already live in the chat (left by an earlier attempt or by the
      // user's own turn) is not this attempt's to wait for.
      backgroundByThread.set(threadId, {
        attemptKey: backgroundAttemptKey(claimed.attempt),
        baseline: new Set(liveness.getThreadLiveTaskIds(threadId)),
        pendingReadyAt: null,
        idleSinceMs: 0,
        clearedAtMs: null,
      });
    }
    yield* publish(changed);
    return claimed;
  });

  // Whether a turn the task does not own is running in its thread. The task's
  // own earlier turn does not count: a turn paused on a provider wait can
  // still read as running until its interrupt lands, and its retry must go.
  const heldByOtherTurn = Effect.fn("PersonalTaskService.heldByOtherTurn")(function* (
    task: PersonalTask,
    threadId: ThreadId,
  ) {
    const session = yield* readSession(threadId).pipe(Effect.orElseSucceed(() => null));
    if (session === null || !sessionIsBusy(session)) return false;
    const own = yield* repository.listAttempts(task.taskId);
    return !own.some(
      (attempt) => attempt.turnId !== null && attempt.turnId === session.activeTurnId,
    );
  });

  // Fills free slots. Slots are active attempts, not task statuses: a parent
  // waiting on children has ended its attempt and holds nothing.
  const pump = Effect.fn("PersonalTaskService.pump")(function* () {
    while (true) {
      const active = yield* repository.listActiveAttempts();
      if (active.length >= PERSONAL_TASKS_CONCURRENCY) {
        return;
      }
      const busyThreads = new Set<string>(active.map((attempt) => attempt.providerThreadId));
      const candidates = yield* repository.listClaimable(yield* DateTime.now);
      // A task bound to a thread also waits while a turn nobody's task owns
      // runs there (the user chatting in that chat): starting now would land
      // in the middle of it. It stays queued, so it still counts as unfinished.
      let next: PersonalTask | undefined;
      idleWaitThreadIds.clear();
      for (const task of candidates) {
        if (task.threadId === null) {
          next = task;
          break;
        }
        if (busyThreads.has(task.threadId)) continue;
        if (yield* heldByOtherTurn(task, task.threadId)) {
          idleWaitThreadIds.add(task.threadId);
          continue;
        }
        next = task;
        break;
      }
      if (next === undefined) {
        return;
      }
      const claimed = yield* claim(next);
      if (claimed === null) {
        continue;
      }
      yield* startTurn(claimed.task, claimed.attempt, claimed.delivered, claimed.notes).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          const message = Cause.pretty(cause);
          return finishAttempt(claimed.attempt, {
            kind: "failed",
            category:
              classifyProviderError(message) === "rate_limited"
                ? "rate_limited"
                : "dispatch_failed",
            message: message.slice(0, 2_000),
          });
        }),
      );
    }
  });

  const activeAttemptForThread = Effect.fn("PersonalTaskService.activeAttemptForThread")(function* (
    threadId: ThreadId,
  ) {
    const active = yield* repository.listActiveAttempts();
    return active.find((attempt) => attempt.providerThreadId === threadId) ?? null;
  });

  const readSession = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(
      Effect.map((shell) => (Option.isSome(shell) ? shell.value.session : null)),
      Effect.mapError((cause) => fail("Personal tasks could not read the thread session.", cause)),
    );

  // A waiting task with an undelivered resume note queues once its notes
  // allow: a note that needs a fresh provider process waits until the
  // thread's session is gone, so the next turn starts a new process (which
  // is when provider environments are built).
  const isWaitingForUser = (status: PersonalTaskStatus) =>
    status === "waiting_for_user" || status === "waiting_for_browser";

  const tryResume = Effect.fn("PersonalTaskService.tryResume")(function* (
    changed: Changed,
    task: PersonalTask,
  ) {
    if (!isWaitingForUser(task.status)) {
      return;
    }
    const notes = yield* repository.listUndeliveredNotes(task.taskId);
    if (notes.length === 0) {
      return;
    }
    if (task.threadId !== null && notes.some((note) => note.restartSession)) {
      if (sessionIsAlive(yield* readSession(task.threadId))) {
        resumingThreadIds.add(task.threadId);
        return;
      }
    }
    if (task.threadId !== null) {
      resumingThreadIds.delete(task.threadId);
    }
    yield* writeTask(changed, task, { status: "queued", errorCategory: null, errorMessage: null });
  });

  const resumeWaiting = Effect.fn("PersonalTaskService.resumeWaiting")(function* (
    threadId: ThreadId | null,
  ) {
    const changed: Changed = [];
    const waiting = yield* repository.listTasksAwaitingResume();
    for (const task of waiting) {
      if (threadId === null || task.threadId === threadId) {
        yield* tryResume(changed, task);
      }
    }
    yield* publish(changed);
  });

  const backgroundFor = (attempt: PersonalTaskAttempt): BackgroundWait => {
    const key = backgroundAttemptKey(attempt);
    const existing = backgroundByThread.get(attempt.providerThreadId);
    if (existing?.attemptKey === key) return existing;
    const created: BackgroundWait = {
      attemptKey: key,
      baseline: new Set(),
      pendingReadyAt: null,
      idleSinceMs: 0,
      clearedAtMs: null,
    };
    backgroundByThread.set(attempt.providerThreadId, created);
    return created;
  };

  /** A turn of the attempt ended with background work left; the task still runs. */
  const waitingOnBackground = (attempt: PersonalTaskAttempt) => {
    const state = backgroundByThread.get(attempt.providerThreadId);
    return state?.attemptKey === backgroundAttemptKey(attempt) && state.pendingReadyAt !== null;
  };

  /**
   * Whether a Claude turn that just ended cleanly is the task's last. Claude
   * Code lets a turn end while commands it started in the background run on,
   * then runs a new turn by itself when they finish; the bot's report is in
   * that turn. So the attempt stays active while such work is live and takes
   * the reply of the turn that ends after it. Returns "wait", or the note to
   * add to the result (empty when there is nothing to say).
   */
  const backgroundOutcome = Effect.fn("PersonalTaskService.backgroundOutcome")(function* (
    attempt: PersonalTaskAttempt,
    session: OrchestrationSession,
  ) {
    const state = backgroundFor(attempt);
    const pending =
      session.providerName === BACKGROUND_WAIT_PROVIDER
        ? liveness
            .getThreadLiveTaskIds(attempt.providerThreadId)
            .filter((taskId) => !state.baseline.has(taskId))
        : [];
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (pending.length > 0) {
      if (state.pendingReadyAt !== session.updatedAt) {
        if (state.pendingReadyAt === null) {
          yield* Effect.logInfo("personal task waiting on background work", {
            taskId: attempt.taskId,
            threadId: attempt.providerThreadId,
            backgroundTasks: pending,
          });
        }
        state.pendingReadyAt = session.updatedAt;
        const endedMs = Date.parse(session.updatedAt);
        state.idleSinceMs = Number.isFinite(endedMs) ? Math.min(endedMs, nowMs) : nowMs;
      }
      state.clearedAtMs = null;
      if (nowMs - state.idleSinceMs < PERSONAL_TASK_BACKGROUND_WAIT_MS) {
        return "wait" as const;
      }
      yield* Effect.logWarning("personal task closed with background work still running", {
        taskId: attempt.taskId,
        threadId: attempt.providerThreadId,
        backgroundTasks: pending,
      });
      return backgroundCapNote(pending.length);
    }
    // Never waited: the turn ends the task exactly as it always has.
    if (state.pendingReadyAt === null) return "";
    // A turn ended after the one that left the work: its reply is the result.
    if (session.updatedAt !== state.pendingReadyAt) return "";
    // The work ended but the turn that reports it has not run yet.
    state.clearedAtMs ??= nowMs;
    return nowMs - state.clearedAtMs < PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS
      ? ("wait" as const)
      : "";
  });

  // Decides whether the attempt's turn has ended, reading the projected
  // session (authoritative) rather than trusting event order. A session state
  // older than the attempt belongs to an earlier turn on the same thread.
  const settle = Effect.fn("PersonalTaskService.settle")(function* (threadId: ThreadId) {
    const attempt = yield* activeAttemptForThread(threadId);
    if (attempt === null) {
      return;
    }
    const shell = yield* snapshots.getThreadShellById(threadId);
    const session = Option.isSome(shell) ? shell.value.session : null;
    if (session === null || session === undefined) {
      return;
    }
    // Everything after this attempt's own user message belongs to it; a
    // session state or reply from an earlier attempt on the same thread does
    // not. Ordering by the anchor, not by clock, keeps equal timestamps safe.
    // Two bounded lookups: this runs per message event and per 30s sweep,
    // and node:sqlite is synchronous, so loading the whole thread here
    // blocked the event loop in proportion to the thread's length.
    const anchorRow = yield* messages.getByMessageId({ messageId: attemptMessageId(attempt) });
    const anchorMessage =
      Option.isSome(anchorRow) && anchorRow.value.threadId === threadId
        ? anchorRow.value
        : undefined;
    const observed = attempt.turnId !== null;
    // Newest assistant reply: by the observed turn id when it has one, else
    // the newest reply written after the anchor. Two bounded lookups replace
    // loading every message of the thread on each event and 30s sweep.
    const latestReply = (): Effect.Effect<
      ProjectionThreadMessage | undefined,
      ProjectionRepositoryError
    > =>
      Effect.gen(function* () {
        if (observed && attempt.turnId !== null) {
          const byTurn = yield* messages.getLatestAssistantMessageForTurn({
            threadId,
            turnId: attempt.turnId,
          });
          if (Option.isSome(byTurn)) return byTurn.value;
        }
        if (anchorMessage === undefined) return undefined;
        const afterAnchor = yield* messages.getLatestAssistantMessageAfter({
          threadId,
          afterCreatedAt: anchorMessage.createdAt,
          afterMessageId: anchorMessage.messageId,
        });
        return Option.getOrUndefined(afterAnchor);
      });
    const fresh =
      anchorMessage !== undefined &&
      Date.parse(session.updatedAt) >= Date.parse(anchorMessage.createdAt);
    switch (session.status) {
      case "ready": {
        if (!observed && !fresh) {
          return;
        }
        const last = yield* latestReply();
        // Unobserved turn: only a fresh reply proves the turn ran. Observed
        // turn: wait until the final message stops streaming.
        if ((!observed && last === undefined) || last?.isStreaming === true) {
          return;
        }
        const note = yield* backgroundOutcome(attempt, session);
        if (note === "wait") {
          return;
        }
        yield* finishAttempt(attempt, {
          kind: "completed",
          summary: withNote(last?.text ?? "", note),
        });
        return;
      }
      case "interrupted":
      case "stopped":
        if (!observed && !fresh) {
          return;
        }
        // The session closed while the task only waited on background work:
        // the bot had already replied, so that reply is the result.
        if (session.status === "stopped" && waitingOnBackground(attempt)) {
          const last = yield* latestReply();
          yield* finishAttempt(attempt, {
            kind: "completed",
            summary: withNote(last?.text ?? "", BACKGROUND_SESSION_ENDED_NOTE),
          });
          return;
        }
        yield* finishAttempt(attempt, { kind: "interrupted", message: session.lastError });
        return;
      case "error": {
        if (!observed && !fresh) {
          return;
        }
        // A turn that failed on a rate limit the adapter recognised waits for
        // the reset it reported (Codex usage limits), not a pattern guess.
        const limit =
          session.providerRetry?.kind === "rate_limited" ? session.providerRetry : undefined;
        const now = yield* DateTime.now;
        const resetMs = limit?.retryAt === undefined ? Number.NaN : Date.parse(limit.retryAt);
        yield* finishAttempt(attempt, {
          kind: "failed",
          category: limit !== undefined ? "rate_limited" : classifyProviderError(session.lastError),
          message: session.lastError,
          ...(Number.isFinite(resetMs)
            ? {
                availableAt: DateTime.add(now, {
                  milliseconds: resetMs - DateTime.toEpochMillis(now),
                }),
              }
            : {}),
        });
        return;
      }
      default:
        return;
    }
  });

  // Gives the slot back when the attempt's turn is stuck on a provider wait:
  // the outcome is written first, so the "interrupted" session that follows
  // settles nothing, then the turn is interrupted by its own thread and turn.
  const pauseForProviderWait = Effect.fn("PersonalTaskService.pauseForProviderWait")(function* (
    attempt: PersonalTaskAttempt,
    pause: ProviderWaitPause,
    now: DateTime.Utc,
  ) {
    const { retry, retryAtMs } = pause;
    const what = retry.kind === "rate_limited" ? "rate limited" : "retrying";
    const detail = retry.reason === undefined ? "" : ` (${retry.reason})`;
    const message =
      retryAtMs === null
        ? `The provider is ${what}${detail} and did not report when the limit resets.`
        : `The provider is ${what}${detail}; its next attempt is at ${DateTime.formatIso(DateTime.makeUnsafe(retryAtMs))}.`;
    yield* finishAttempt(attempt, {
      kind: "failed",
      category: "rate_limited",
      message,
      ...(retryAtMs === null
        ? {}
        : {
            availableAt: DateTime.add(now, {
              milliseconds: retryAtMs - DateTime.toEpochMillis(now),
            }),
          }),
    });
    yield* engine
      .dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(
          `personal-task:${attempt.taskId}:${attempt.attempt}:provider-wait`,
        ),
        threadId: attempt.providerThreadId,
        ...(attempt.turnId !== null ? { turnId: attempt.turnId } : {}),
        createdAt: DateTime.formatIso(now),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("personal task could not interrupt a turn waiting on its provider", {
            taskId: attempt.taskId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });

  const observeSession = Effect.fn("PersonalTaskService.observeSession")(function* (
    threadId: ThreadId,
    session: OrchestrationSession,
  ) {
    if (session.status === "running") {
      let attempt = yield* activeAttemptForThread(threadId);
      // A turn after one that left background work running (Claude Code's
      // own follow-up, or a steer) is the attempt's turn from then on, so its
      // reply is the one the task reports.
      if (
        attempt !== null &&
        session.activeTurnId !== null &&
        attempt.turnId !== session.activeTurnId &&
        (attempt.turnId === null || waitingOnBackground(attempt))
      ) {
        attempt = { ...attempt, turnId: session.activeTurnId };
        yield* repository.writeAttempt(attempt);
      }
      if (attempt !== null) {
        const now = yield* DateTime.now;
        const pause = providerWaitPause(session.providerRetry, DateTime.toEpochMillis(now));
        if (pause !== null) {
          yield* pauseForProviderWait(attempt, pause, now);
          return;
        }
      }
    }
    yield* settle(threadId);
  });

  const sweepOnce = Effect.fn("PersonalTaskService.sweepOnce")(function* () {
    const now = yield* DateTime.now;
    yield* repository.heartbeat({
      leaseOwner,
      now,
      leaseExpiresAt: minutesFrom(now, LEASE_MINUTES),
    });
    const active = yield* refreshActiveThreads();
    const nowMs = DateTime.toEpochMillis(now);
    for (const attempt of active) {
      if (
        attempt.leaseOwner !== leaseOwner &&
        DateTime.toEpochMillis(attempt.leaseExpiresAt) < nowMs
      ) {
        // The owning process died mid-turn. Interrupted (resumable), not
        // re-queued: re-running could repeat side effects of a turn we
        // cannot see. `personalTasks.retry` resumes it on the same thread.
        yield* finishAttempt(attempt, {
          kind: "interrupted",
          message: "The server stopped while this task was running.",
        });
        continue;
      }
      yield* settle(attempt.providerThreadId);
    }
    // Also covers a restart: provider sessions do not survive one, so a task
    // that was waiting for its session to stop can resume now.
    yield* resumeWaiting(null);
    yield* pump();
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

  const createTask: PersonalTaskService["Service"]["createTask"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const existing = yield* repository.getTaskByIdempotencyKey(input.idempotencyKey);
          if (Option.isSome(existing)) {
            return existing.value;
          }
          yield* requireLiveBot(input.botId);
          const now = yield* DateTime.now;
          const taskId = PersonalTaskId.make(NodeCrypto.randomUUID());
          const task: PersonalTask = {
            taskId,
            rootTaskId: taskId,
            parentTaskId: null,
            botId: input.botId,
            threadId: input.threadId ?? null,
            title: input.title,
            objective: input.objective,
            acceptanceCriteria: input.acceptanceCriteria ?? "",
            expectedOutput: input.expectedOutput ?? "",
            status: "queued",
            source: input.source ?? "user",
            idempotencyKey: input.idempotencyKey,
            depth: 0,
            maxDepth: input.maxDepth ?? PERSONAL_TASKS_DEFAULT_MAX_DEPTH,
            maxChildren: input.maxChildren ?? PERSONAL_TASKS_DEFAULT_MAX_CHILDREN,
            result: null,
            errorCategory: null,
            errorMessage: null,
            availableAt: null,
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            completedAt: null,
          };
          const inserted = yield* repository.insertTask(task);
          // A concurrent create with the same key may have won the insert.
          const stored = yield* repository.getTaskByIdempotencyKey(input.idempotencyKey);
          if (Option.isNone(stored)) {
            return yield* fail("Personal task could not be read after creation.");
          }
          if (inserted) {
            yield* publish([stored.value]);
            yield* worker.enqueue({ type: "pump" });
          }
          return stored.value;
        }),
      )
      .pipe(toPublic("create"));

  // Everything the relay writes is keyed on the idempotency key: the thread
  // id, the message id and every command id. A retry after a crash between
  // the dispatches and the insert re-sends commands the engine has already
  // receipted, and then records the task. The dispatches run outside the
  // service lock, as startTurn's do, so engine events never wait on it.
  const relay: PersonalTaskService["Service"]["relay"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository.getTaskByIdempotencyKey(input.idempotencyKey);
      if (Option.isSome(existing)) {
        return existing.value;
      }
      yield* requireLiveBot(input.botId);
      const digest = NodeCrypto.createHash("sha256")
        .update(`personal-relay\n${input.idempotencyKey}`)
        .digest("hex");
      const threadId = ThreadId.make(
        [
          digest.slice(0, 8),
          digest.slice(8, 12),
          digest.slice(12, 16),
          digest.slice(16, 20),
          digest.slice(20, 32),
        ].join("-"),
      );
      const messageId = MessageId.make(`personal-relay-${digest.slice(0, 32)}`);
      const title = input.title.trim().length > 0 ? input.title.trim() : "Routine";
      yield* bots
        .createThread({ botId: input.botId, threadId })
        .pipe(Effect.mapError((cause) => fail("The relay could not open a chat.", cause)));
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const commandId = (step: string) =>
        CommandId.make(`personal-relay:${digest.slice(0, 32)}:${step}`);
      yield* Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: commandId("title"),
          threadId,
          title,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: commandId("delta"),
          threadId,
          messageId,
          delta: input.text,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: commandId("complete"),
          threadId,
          messageId,
          createdAt,
        });
      }).pipe(Effect.mapError((cause) => fail("The relay could not post its message.", cause)));
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const taskId = PersonalTaskId.make(NodeCrypto.randomUUID());
          const task: PersonalTask = {
            taskId,
            rootTaskId: taskId,
            parentTaskId: null,
            botId: input.botId,
            threadId,
            title,
            objective: input.text,
            acceptanceCriteria: "",
            expectedOutput: "",
            status: "completed",
            source: input.source ?? "user",
            idempotencyKey: input.idempotencyKey,
            depth: 0,
            maxDepth: PERSONAL_TASKS_DEFAULT_MAX_DEPTH,
            maxChildren: PERSONAL_TASKS_DEFAULT_MAX_CHILDREN,
            result: { summary: input.text },
            errorCategory: null,
            errorMessage: null,
            availableAt: null,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            completedAt: now,
          };
          const inserted = yield* repository.insertTask(task);
          const stored = yield* repository.getTaskByIdempotencyKey(input.idempotencyKey);
          if (Option.isNone(stored)) {
            return yield* fail("Personal task could not be read after creation.");
          }
          if (inserted) {
            yield* publish([stored.value]);
          }
          return stored.value;
        }),
      );
    }).pipe(toPublic("relay"));

  const delegate: PersonalTaskService["Service"]["delegate"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const parent = yield* requireTask(input.parentTaskId);
          const idempotencyKey =
            input.idempotencyKey ??
            `delegate:${parent.taskId}:${NodeCrypto.createHash("sha256")
              .update(
                [
                  input.targetBotId,
                  input.brief.title,
                  input.brief.objective,
                  input.brief.context ?? "",
                  input.brief.constraints ?? "",
                  input.brief.acceptanceCriteria ?? "",
                  input.brief.expectedOutput ?? "",
                ].join(" "),
              )
              .digest("hex")
              .slice(0, 24)}`;
          const existing = yield* repository.getTaskByIdempotencyKey(idempotencyKey);
          if (Option.isSome(existing)) {
            return existing.value;
          }
          if (isTerminal(parent.status)) {
            return yield* fail(`Task '${parent.taskId}' is ${parent.status}; it cannot delegate.`);
          }
          yield* requireLiveBot(input.targetBotId);
          const root =
            parent.parentTaskId === null ? parent : yield* requireTask(parent.rootTaskId);
          const depth = parent.depth + 1;
          if (depth > root.maxDepth) {
            return yield* fail(`Delegation depth limit reached (max depth ${root.maxDepth}).`);
          }
          const children = (yield* repository.countTasksInRoot(root.taskId)) - 1;
          if (children >= root.maxChildren) {
            return yield* fail(
              `Delegation limit reached (at most ${root.maxChildren} delegated tasks per request).`,
            );
          }
          const chain: Array<PersonalTask> = [parent];
          let cursor = parent;
          while (cursor.parentTaskId !== null) {
            cursor = yield* requireTask(cursor.parentTaskId);
            chain.push(cursor);
          }
          // A child may hand work back to the root's bot; any other repeat of
          // a bot already in the chain is a loop.
          const returningToRoot = input.targetBotId === root.botId && parent.taskId !== root.taskId;
          if (!returningToRoot && chain.some((task) => task.botId === input.targetBotId)) {
            return yield* fail(
              `Delegation loop: bot '${input.targetBotId}' is already working on this request.`,
            );
          }
          const now = yield* DateTime.now;
          const taskId = PersonalTaskId.make(NodeCrypto.randomUUID());
          const child: PersonalTask = {
            taskId,
            rootTaskId: root.taskId,
            parentTaskId: parent.taskId,
            botId: input.targetBotId,
            threadId: null,
            title: input.brief.title,
            objective: input.brief.objective,
            acceptanceCriteria: input.brief.acceptanceCriteria ?? "",
            expectedOutput: input.brief.expectedOutput ?? "",
            status: "queued",
            source: "delegation",
            idempotencyKey,
            depth,
            maxDepth: root.maxDepth,
            maxChildren: root.maxChildren,
            result: null,
            errorCategory: null,
            errorMessage: null,
            availableAt: null,
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            completedAt: null,
          };
          const inserted = yield* repository.transaction(
            Effect.gen(function* () {
              const insertedTask = yield* repository.insertTask(child);
              if (insertedTask) {
                yield* repository.insertHandoff({
                  parentTaskId: parent.taskId,
                  childTaskId: taskId,
                  brief: input.brief,
                  dependencies: [...(input.dependencies ?? [])],
                  resultSummary: null,
                  status: "pending",
                  createdAt: now,
                  updatedAt: now,
                });
              }
              return insertedTask;
            }),
          );
          const stored = yield* repository.getTaskByIdempotencyKey(idempotencyKey);
          if (Option.isNone(stored)) {
            return yield* fail("Delegated task could not be read after creation.");
          }
          if (inserted) {
            yield* publish([stored.value]);
            yield* worker.enqueue({ type: "pump" });
          }
          return stored.value;
        }),
      )
      .pipe(toPublic("delegate"));

  const cancel: PersonalTaskService["Service"]["cancel"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId);
          const changed: Changed = [];
          const interrupted: Array<PersonalTaskAttempt> = [];
          yield* repository.transaction(
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const descendants = yield* repository.listDescendants(task.taskId);
              const cascade = new Set<string>([
                task.taskId,
                ...descendants.map((entry) => entry.taskId),
              ]);
              const active = yield* repository.listActiveAttempts();
              for (const target of [task, ...descendants]) {
                // Finished children keep their outcome; completed is never undone.
                if (isTerminal(target.status)) continue;
                const attempt = active.find((entry) => entry.taskId === target.taskId);
                if (attempt !== undefined) {
                  yield* repository.writeAttempt({
                    ...attempt,
                    endedAt: now,
                    errorCategory: "cancelled",
                    resumable: false,
                  });
                  interrupted.push(attempt);
                }
                const isTop = target.taskId === task.taskId;
                yield* writeTask(changed, target, {
                  status: "cancelled",
                  availableAt: null,
                  completedAt: now,
                  errorCategory: "cancelled",
                  errorMessage: isTop ? "Cancelled." : "Cancelled with its parent task.",
                });
                if (!isTop) {
                  const handoff = yield* repository.getHandoffByChild(target.taskId);
                  if (Option.isSome(handoff) && handoff.value.status === "pending") {
                    yield* repository.writeHandoff({
                      ...handoff.value,
                      status: "cancelled",
                      resultSummary: "Cancelled with its parent task.",
                      updatedAt: now,
                    });
                  }
                }
              }
              // A cancelled child whose parent survives reports back to it.
              const top = changed.find((entry) => entry.taskId === task.taskId);
              if (
                top !== undefined &&
                top.parentTaskId !== null &&
                !cascade.has(top.parentTaskId)
              ) {
                yield* returnToParent(changed, top);
              }
            }),
          );
          const interruptedAt = yield* DateTime.now;
          const createdAt = DateTime.formatIso(interruptedAt);
          for (const attempt of interrupted) {
            releaseThread(attempt.providerThreadId, DateTime.toEpochMillis(interruptedAt));
            // Interrupt by the attempt's own thread (and turn when known),
            // never by process name.
            yield* engine
              .dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.make(
                  `personal-task:${attempt.taskId}:${attempt.attempt}:interrupt`,
                ),
                threadId: attempt.providerThreadId,
                ...(attempt.turnId !== null ? { turnId: attempt.turnId } : {}),
                createdAt,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("personal task cancel could not interrupt its turn", {
                    taskId: attempt.taskId,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
          }
          yield* publish(changed);
          yield* worker.enqueue({ type: "pump" });
          return yield* requireTask(task.taskId);
        }),
      )
      .pipe(toPublic("cancel"));

  const retry: PersonalTaskService["Service"]["retry"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId);
          if (!PERSONAL_TASK_RETRYABLE_STATUSES.includes(task.status)) {
            return yield* fail(
              `Only failed, interrupted or cancelled tasks can be retried; this one is ${task.status}.`,
            );
          }
          const changed: Changed = [];
          yield* repository.transaction(
            Effect.gen(function* () {
              const queued = yield* writeTask(changed, task, {
                status: "queued",
                result: null,
                availableAt: null,
                completedAt: null,
                errorCategory: null,
                errorMessage: null,
              });
              const handoff = yield* repository.getHandoffByChild(task.taskId);
              if (
                queued !== null &&
                Option.isSome(handoff) &&
                (handoff.value.status === "returned" || handoff.value.status === "cancelled")
              ) {
                yield* repository.writeHandoff({
                  ...handoff.value,
                  status: "pending",
                  resultSummary: null,
                  updatedAt: yield* DateTime.now,
                });
              }
            }),
          );
          yield* publish(changed);
          yield* worker.enqueue({ type: "pump" });
          return yield* requireTask(task.taskId);
        }),
      )
      .pipe(toPublic("retry"));

  const steerText = (fromName: string, message: string) =>
    `Update from ${fromName.trim() || "your delegator"}: ${message.trim()}`;

  // Under the service lock, like claim and settle: the task cannot start,
  // settle or be cancelled between the status read and the delivery.
  const steer: PersonalTaskService["Service"]["steer"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId);
          if (input.message.trim().length === 0) {
            return yield* fail("The update is empty; say what should change.");
          }
          if (isTerminal(task.status)) {
            return yield* fail(
              `That task is already ${task.status}, so there is nothing to steer. Delegate a new task if more work is needed.`,
            );
          }
          const now = yield* DateTime.now;
          const steerId = NodeCrypto.randomUUID().replaceAll("-", "");
          const noteId = `${PersonalTaskRepository.PERSONAL_TASK_STEER_NOTE_PREFIX}${steerId}`;
          const text = steerText(input.fromName, input.message);
          if (task.status !== "running") {
            // Opens its next turn: for a queued task that is its first, so the
            // update is part of the brief it starts with.
            yield* repository.insertResumeNote({
              noteId,
              taskId: task.taskId,
              text,
              restartSession: false,
              createdAt: now,
            });
            return { outcome: "queued" as const, task, text };
          }
          const attempt = (yield* repository.listActiveAttempts()).find(
            (entry) => entry.taskId === task.taskId,
          );
          const shell =
            attempt === undefined
              ? Option.none()
              : yield* snapshots
                  .getThreadShellById(attempt.providerThreadId)
                  .pipe(Effect.orElseSucceed(() => Option.none()));
          const thread = Option.getOrUndefined(shell);
          // A task waiting on background work it left running is between
          // turns but still running: a turn started now is its turn.
          if (
            attempt === undefined ||
            (!sessionIsBusy(thread?.session) && !waitingOnBackground(attempt))
          ) {
            // Its turn is starting or just ended. A turn started now would run
            // outside the task, and a note could wait for a turn that never
            // comes, so say so rather than guess.
            return yield* fail(
              "That task is between turns (just starting or just finishing). Check it with get_task and try again in a moment.",
            );
          }
          // The selection the task's turn runs with. A different one restarts
          // a Claude session, which would end the very turn this steers, so a
          // bot edited mid-task keeps its running selection until its next turn.
          const botSelection = yield* botModelSelectionForThread(
            botRepository,
            attempt.providerThreadId,
            thread?.modelSelection,
          );
          const modelSelection =
            thread?.modelSelection !== undefined &&
            botSelection !== undefined &&
            !Equal.equals(botSelection, thread.modelSelection)
              ? thread.modelSelection
              : botSelection;
          // The normal turn path: a turn start on a thread whose turn is
          // running steers that turn instead of starting another. The thread's
          // own modes, since a changed runtime mode restarts the session.
          yield* engine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`personal-task:${task.taskId}:steer:${steerId}`),
              threadId: attempt.providerThreadId,
              ...(modelSelection !== undefined ? { modelSelection } : {}),
              message: {
                messageId: personalTaskSteerMessageId(steerId),
                role: "user",
                text,
                attachments: [],
              },
              runtimeMode: thread?.runtimeMode ?? "full-access",
              interactionMode: thread?.interactionMode ?? "default",
              createdAt: DateTime.formatIso(now),
            })
            .pipe(Effect.mapError((cause) => fail("Could not deliver the update.", cause)));
          yield* repository.insertResumeNote({
            noteId,
            taskId: task.taskId,
            text,
            restartSession: false,
            createdAt: now,
            deliveredAt: now,
          });
          return { outcome: "steered" as const, task, text };
        }),
      )
      .pipe(toPublic("steer"));

  const steers: PersonalTaskService["Service"]["steers"] = (input) =>
    repository.listSteerNotes(input.taskId).pipe(
      Effect.map((notes) =>
        notes.map((note) => ({
          text: note.text,
          createdAt: note.createdAt,
          deliveredAt: note.deliveredAt,
        })),
      ),
      toPublic("steers"),
    );

  const get: PersonalTaskService["Service"]["get"] = (input) =>
    Effect.gen(function* () {
      const task = yield* requireTask(input.taskId);
      const [attempts, children, handoff] = yield* Effect.all([
        repository.listAttempts(task.taskId),
        repository.listHandoffsByParent(task.taskId),
        repository.getHandoffByChild(task.taskId),
      ]);
      return {
        task,
        attempts: [...attempts],
        children: [...children],
        handoff: Option.getOrNull(handoff),
      } satisfies PersonalTaskDetail;
    }).pipe(toPublic("get"));

  const list: PersonalTaskService["Service"]["list"] = (filter) =>
    repository.listTasks(filter).pipe(
      Effect.map((tasks) => ({ tasks: [...tasks] })),
      toPublic("list"),
    );

  // Subscribe before reading the replay so no change falls in between; a
  // task changed in that window is sent twice, which upserts absorb.
  const subscribe: PersonalTaskService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      const summaries = serverPerfOptimizationOn("task-summaries");
      const subscription = yield* PubSub.subscribe(upserts);
      // A phone PWA reconnects constantly; replaying every task ever would
      // grow without bound, so finished history is capped here.
      const current = yield* repository
        .listForReplay(summaries ? TASK_REPLAY_TERMINAL_LIMIT : TASK_REPLAY_TERMINAL_LIMIT_FULL)
        .pipe(toPublic("subscribe"));
      return Stream.concat(
        Stream.fromIterable(current),
        Stream.fromSubscription(subscription),
      ).pipe(
        Stream.map((task) => ({
          type: "upsert" as const,
          task: summaries ? toTaskSummary(task) : task,
        })),
      );
    }),
  );

  const history: PersonalTaskService["Service"]["history"] = (input) => {
    const limit = Math.min(
      TASK_HISTORY_MAX_LIMIT,
      Math.max(1, Math.floor(input.limit ?? TASK_HISTORY_DEFAULT_LIMIT)),
    );
    // One extra row says whether another page exists.
    return repository.listTerminalPage({ before: input.before ?? null, limit: limit + 1 }).pipe(
      Effect.map((tasks) => ({
        tasks: tasks.slice(0, limit).map(toTaskSummary),
        hasMore: tasks.length > limit,
      })),
      toPublic("history"),
    );
  };

  const related: PersonalTaskService["Service"]["related"] = (input) =>
    repository
      .listRelated({
        threadId: input.threadId ?? null,
        taskIds: (input.taskIds ?? []).slice(0, TASK_RELATED_MAX_IDS),
      })
      .pipe(
        Effect.map((tasks) => ({ tasks: tasks.map(toTaskSummary) })),
        toPublic("related"),
      );

  const resolveCallerTask: PersonalTaskService["Service"]["resolveCallerTask"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const active = yield* activeAttemptForThread(input.threadId);
          if (active !== null) {
            const owner = yield* repository.getTask(active.taskId);
            if (Option.isSome(owner) && !isTerminal(owner.value.status)) {
              return owner.value;
            }
          }
          // No task owns this turn (the user is chatting directly): adopt the
          // running turn as attempt 1 of a new root, keyed by thread and turn
          // so every tool call in this turn resolves to the same root.
          const idempotencyKey = `thread-turn:${input.threadId}:${input.turnId}`;
          const existing = yield* repository.getTaskByIdempotencyKey(idempotencyKey);
          if (Option.isSome(existing)) {
            return existing.value;
          }
          yield* requireLiveBot(input.botId);
          const threadMessages = yield* messages
            .listByThreadId({ threadId: input.threadId })
            .pipe(
              Effect.mapError((cause) => fail("Personal tasks could not read the thread.", cause)),
            );
          const lastUserText =
            threadMessages.findLast((message) => message.role === "user")?.text.trim() ?? "";
          const objective =
            lastUserText.length > 0
              ? lastUserText.slice(0, 4_000)
              : "Continue the conversation in this thread.";
          const title = (objective.split("\n")[0] ?? "").trim().slice(0, 80) || "Chat request";
          const now = yield* DateTime.now;
          const taskId = PersonalTaskId.make(NodeCrypto.randomUUID());
          const task: PersonalTask = {
            taskId,
            rootTaskId: taskId,
            parentTaskId: null,
            botId: input.botId,
            threadId: input.threadId,
            title,
            objective,
            acceptanceCriteria: "",
            expectedOutput: "",
            status: "running",
            source: "user",
            idempotencyKey,
            depth: 0,
            maxDepth: PERSONAL_TASKS_DEFAULT_MAX_DEPTH,
            maxChildren: PERSONAL_TASKS_DEFAULT_MAX_CHILDREN,
            result: null,
            errorCategory: null,
            errorMessage: null,
            availableAt: null,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            completedAt: null,
          };
          const attempt: PersonalTaskAttempt = {
            taskId,
            attempt: 1,
            providerThreadId: input.threadId,
            turnId: input.turnId,
            leaseOwner,
            leaseExpiresAt: minutesFrom(now, LEASE_MINUTES),
            heartbeatAt: now,
            startedAt: now,
            endedAt: null,
            errorCategory: null,
            resumable: false,
          };
          const inserted = yield* repository.transaction(
            Effect.gen(function* () {
              const insertedTask = yield* repository.insertTask(task);
              if (insertedTask) {
                yield* repository.insertAttempt(attempt);
              }
              return insertedTask;
            }),
          );
          const stored = yield* repository.getTaskByIdempotencyKey(idempotencyKey);
          if (Option.isNone(stored)) {
            return yield* fail("Personal task could not be read after creation.");
          }
          if (inserted) {
            activeThreadIds.add(input.threadId);
            yield* publish([stored.value]);
          }
          return stored.value;
        }),
      )
      .pipe(toPublic("resolveCallerTask"));

  const ownsThreadTurn: PersonalTaskService["Service"]["ownsThreadTurn"] = (threadId) =>
    Effect.gen(function* () {
      if (activeThreadIds.has(threadId)) return true;
      const settledAt = settledThreadAtMs.get(threadId);
      if (settledAt === undefined) return false;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (nowMs - settledAt >= PERSONAL_TASK_TURN_OWNERSHIP_MS) {
        settledThreadAtMs.delete(threadId);
        return false;
      }
      return true;
    });

  const rootTaskIdForThread: PersonalTaskService["Service"]["rootTaskIdForThread"] = (threadId) =>
    Effect.gen(function* () {
      const active = yield* activeAttemptForThread(threadId);
      const task =
        active !== null
          ? yield* repository.getTask(active.taskId)
          : yield* repository.latestTaskForThread(threadId);
      return Option.map(task, (value) => value.rootTaskId);
    }).pipe(toPublic("rootTaskIdForThread"));

  const parkForUser = (
    input: { readonly taskId: PersonalTaskId },
    waitingStatus: "waiting_for_user" | "waiting_for_browser",
  ) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId);
          if (task.status === waitingStatus) {
            return task;
          }
          if (task.status !== "running") {
            return yield* fail(
              `Task '${task.taskId}' is ${task.status}; only a running task can wait.`,
            );
          }
          const changed: Changed = [];
          const waiting = yield* writeTask(changed, task, { status: waitingStatus });
          if (waiting === null) {
            return yield* fail("The task changed while it was being parked; try again.");
          }
          yield* publish(changed);
          return waiting;
        }),
      )
      .pipe(toPublic(waitingStatus === "waiting_for_browser" ? "waitForBrowser" : "waitForUser"));

  const waitForUser: PersonalTaskService["Service"]["waitForUser"] = (input) =>
    parkForUser(input, "waiting_for_user");

  const waitForBrowser: PersonalTaskService["Service"]["waitForBrowser"] = (input) =>
    parkForUser(input, "waiting_for_browser");

  const resumeFromUser: PersonalTaskService["Service"]["resumeFromUser"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId);
          if (!isWaitingForUser(task.status)) {
            return yield* fail(
              `Task '${task.taskId}' is ${task.status}; it is not waiting for you.`,
            );
          }
          const now = yield* DateTime.now;
          if (input.restartSession && task.threadId !== null) {
            if (sessionIsAlive(yield* readSession(task.threadId))) {
              // The environment is fixed when a provider process starts; stop
              // it and queue on the "stopped" session event (tryResume).
              resumingThreadIds.add(task.threadId);
              yield* engine
                .dispatch({
                  type: "thread.session.stop",
                  commandId: CommandId.make(
                    `personal-task:${task.taskId}:resume:${input.noteId}:session.stop`,
                  ),
                  threadId: task.threadId,
                  createdAt: DateTime.formatIso(now),
                })
                .pipe(
                  Effect.mapError((cause) =>
                    fail("Could not restart the bot's provider session.", cause),
                  ),
                );
            }
          }
          yield* repository.insertResumeNote({
            noteId: input.noteId,
            taskId: task.taskId,
            text: input.note,
            restartSession: input.restartSession,
            createdAt: now,
          });
          const changed: Changed = [];
          yield* tryResume(changed, task);
          yield* publish(changed);
          yield* worker.enqueue({ type: "pump" });
          return yield* requireTask(task.taskId);
        }),
      )
      .pipe(toPublic("resumeFromUser"));

  const failWaitingForUser: PersonalTaskService["Service"]["failWaitingForUser"] = (input) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const task = yield* requireTask(input.taskId);
          if (!isWaitingForUser(task.status)) {
            return yield* fail(
              `Task '${task.taskId}' is ${task.status}; it is not waiting for you.`,
            );
          }
          const changed: Changed = [];
          yield* repository.transaction(
            Effect.gen(function* () {
              const ended = yield* writeTask(changed, task, {
                status: "failed",
                availableAt: null,
                errorCategory: "user_cancelled",
                errorMessage: input.message,
                completedAt: yield* DateTime.now,
              });
              if (ended !== null) {
                yield* returnToParent(changed, ended);
              }
            }),
          );
          if (task.threadId !== null) {
            resumingThreadIds.delete(task.threadId);
          }
          yield* publish(changed);
          yield* worker.enqueue({ type: "pump" });
          return yield* requireTask(task.taskId);
        }),
      )
      .pipe(toPublic("failWaitingForUser"));

  const start: PersonalTaskService["Service"]["start"] = Effect.fn("PersonalTaskService.start")(
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
