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
  MessageId,
  PERSONAL_TASK_RETRYABLE_STATUSES,
  PERSONAL_TASK_TERMINAL_STATUSES,
  PersonalTaskId,
  PersonalTasksError,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type PersonalBotId,
  type PersonalDelegationBrief,
  type PersonalHandoff,
  type PersonalTask,
  type PersonalTaskAttempt,
  type PersonalTaskCreateInput,
  type PersonalTaskDetail,
  type PersonalTaskListInput,
  type PersonalTaskListResult,
  type PersonalTaskSource,
  type PersonalTaskStatus,
  type PersonalTaskStreamEvent,
} from "@t3tools/contracts";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { forkParked } from "../../serverActivation.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";

/** Global cap on active provider turns started by the dispatcher. */
export const PERSONAL_TASKS_CONCURRENCY = 2;
export const PERSONAL_TASKS_DEFAULT_MAX_DEPTH = 2;
export const PERSONAL_TASKS_DEFAULT_MAX_CHILDREN = 4;
/** Backoff before each rate-limited re-run; one more rate limit fails the task. */
export const PERSONAL_TASKS_RATE_LIMIT_BACKOFF_MINUTES = [1, 5, 15] as const;
const LEASE_MINUTES = 2;
const SWEEP_INTERVAL = "30 seconds";

const RATE_LIMIT_PATTERN =
  /rate.?limit|too many requests|\b429\b|\b529\b|overloaded|quota|usage limit|provider.{0,40}unavailable|service unavailable|\b503\b/i;

/** Rate limits and an unreachable provider back off; anything else fails the attempt. */
export const classifyProviderError = (message: string | null): "rate_limited" | "provider_error" =>
  message !== null && RATE_LIMIT_PATTERN.test(message) ? "rate_limited" : "provider_error";

export interface PersonalTaskCreateOptions extends PersonalTaskCreateInput {
  readonly source?: PersonalTaskSource;
  readonly maxDepth?: number;
  readonly maxChildren?: number;
}

export interface PersonalTaskDelegateInput {
  readonly parentTaskId: PersonalTaskId;
  readonly targetBotId: PersonalBotId;
  readonly brief: PersonalDelegationBrief;
  /** Defaults to a hash of parent, target and brief, so a retried tool call dedupes. */
  readonly idempotencyKey?: string;
  readonly dependencies?: ReadonlyArray<PersonalTaskId>;
}

export class PersonalTaskService extends Context.Service<
  PersonalTaskService,
  {
    readonly createTask: (
      input: PersonalTaskCreateOptions,
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
    readonly get: (input: {
      readonly taskId: PersonalTaskId;
    }) => Effect.Effect<PersonalTaskDetail, PersonalTasksError>;
    readonly list: (
      filter: PersonalTaskListInput,
    ) => Effect.Effect<PersonalTaskListResult, PersonalTasksError>;
    /** Every current task as an upsert, then live upserts. */
    readonly subscribe: Stream.Stream<PersonalTaskStreamEvent, PersonalTasksError>;
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
    };

type WorkItem =
  | { readonly type: "pump" }
  | { readonly type: "sweep" }
  | {
      readonly type: "session";
      readonly threadId: ThreadId;
      readonly session: OrchestrationSession;
    }
  | { readonly type: "settle"; readonly threadId: ThreadId };

const isTerminal = (status: PersonalTaskStatus) => PERSONAL_TASK_TERMINAL_STATUSES.includes(status);

const minutesFrom = (now: DateTime.Utc, minutes: number) => DateTime.add(now, { minutes });

/** The user message that starts an attempt's turn; deterministic so a re-dispatch dedupes. */
const attemptMessageId = (attempt: PersonalTaskAttempt) =>
  MessageId.make(`personal-task-${attempt.taskId}-${attempt.attempt}`);

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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
  const botRepository = yield* PersonalBotRepository.PersonalBotRepository;
  const bots = yield* PersonalBotService.PersonalBotService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const messages = yield* ProjectionThreadMessageRepository;

  // One owner per server process: a lease held by anyone else and past its
  // expiry belongs to a process that died mid-turn.
  const leaseOwner = `personal-tasks:${NodeCrypto.randomUUID()}`;
  const upserts = yield* PubSub.unbounded<PersonalTask>();
  // Serialises public mutations with dispatcher steps, so a claim never
  // interleaves with a cancel or a delegation on the same rows.
  const lock = yield* Semaphore.make(1);
  // Provider threads with an active attempt; filters the hot event stream.
  const activeThreadIds = new Set<string>();

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
    activeThreadIds.delete(attempt.providerThreadId);
    yield* publish(changed);
  });

  const buildTurnText = Effect.fn("PersonalTaskService.buildTurnText")(function* (
    task: PersonalTask,
    attemptNumber: number,
    delivered: ReadonlyArray<PersonalHandoff>,
  ) {
    if (delivered.length > 0) {
      const results = yield* Effect.forEach(delivered, (handoff) =>
        repository.getTask(handoff.childTaskId).pipe(
          Effect.map((child) => {
            const status = Option.match(child, {
              onNone: () => "unknown",
              onSome: (value) => value.status,
            });
            return `### ${handoff.brief.title} (${status})\n${handoff.resultSummary ?? ""}`;
          }),
        ),
      );
      return [
        "[Task continuation] Your delegated tasks have finished. Their results:",
        ...results,
        "Continue the task below with these results and give your final answer.",
        ...taskSections(task, null),
      ].join("\n\n");
    }
    const handoff = yield* repository.getHandoffByChild(task.taskId);
    let delegatorName: string | null = null;
    if (Option.isSome(handoff)) {
      const parent = yield* repository.getTask(handoff.value.parentTaskId);
      if (Option.isSome(parent)) {
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
    return [
      header,
      ...taskSections(task, Option.isSome(handoff) ? handoff.value.brief : null),
    ].join("\n\n");
  });

  // Creates the bot thread on first use and starts the turn. Deterministic
  // command and message ids make a repeated start of one attempt dedupe on
  // the orchestration command receipt.
  const startTurn = Effect.fn("PersonalTaskService.startTurn")(function* (
    task: PersonalTask,
    attempt: PersonalTaskAttempt,
    delivered: ReadonlyArray<PersonalHandoff>,
  ) {
    const text = yield* buildTurnText(task, attempt.attempt, delivered);
    yield* bots.createThread({ botId: task.botId, threadId: attempt.providerThreadId });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`personal-task:${task.taskId}:${attempt.attempt}:turn.start`),
      threadId: attempt.providerThreadId,
      message: {
        messageId: attemptMessageId(attempt),
        role: "user",
        text,
        attachments: [],
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
        return { task: running, attempt, delivered };
      }),
    );
    if (claimed !== null) {
      activeThreadIds.add(claimed.attempt.providerThreadId);
    }
    yield* publish(changed);
    return claimed;
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
      const next = candidates.find(
        (task) => task.threadId === null || !busyThreads.has(task.threadId),
      );
      if (next === undefined) {
        return;
      }
      const claimed = yield* claim(next);
      if (claimed === null) {
        continue;
      }
      yield* startTurn(claimed.task, claimed.attempt, claimed.delivered).pipe(
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
    const threadMessages = yield* messages.listByThreadId({ threadId });
    const anchor = threadMessages.findIndex(
      (message) => message.messageId === attemptMessageId(attempt),
    );
    const anchorMessage = anchor === -1 ? undefined : threadMessages[anchor];
    const observed = attempt.turnId !== null;
    const fresh =
      anchorMessage !== undefined &&
      Date.parse(session.updatedAt) >= Date.parse(anchorMessage.createdAt);
    switch (session.status) {
      case "ready": {
        if (!observed && !fresh) {
          return;
        }
        const byTurn = observed
          ? threadMessages.filter(
              (message) => message.role === "assistant" && message.turnId === attempt.turnId,
            )
          : [];
        const afterAnchor =
          anchor === -1
            ? []
            : threadMessages.slice(anchor + 1).filter((message) => message.role === "assistant");
        const candidates = byTurn.length > 0 ? byTurn : afterAnchor;
        const last = candidates.at(-1);
        // Unobserved turn: only a fresh reply proves the turn ran. Observed
        // turn: wait until the final message stops streaming.
        if ((!observed && last === undefined) || last?.isStreaming === true) {
          return;
        }
        yield* finishAttempt(attempt, { kind: "completed", summary: last?.text ?? "" });
        return;
      }
      case "interrupted":
      case "stopped":
        if (!observed && !fresh) {
          return;
        }
        yield* finishAttempt(attempt, { kind: "interrupted", message: session.lastError });
        return;
      case "error":
        if (!observed && !fresh) {
          return;
        }
        yield* finishAttempt(attempt, {
          kind: "failed",
          category: classifyProviderError(session.lastError),
          message: session.lastError,
        });
        return;
      default:
        return;
    }
  });

  const observeSession = Effect.fn("PersonalTaskService.observeSession")(function* (
    threadId: ThreadId,
    session: OrchestrationSession,
  ) {
    if (session.status === "running" && session.activeTurnId !== null) {
      const attempt = yield* activeAttemptForThread(threadId);
      if (attempt !== null && attempt.turnId === null) {
        yield* repository.writeAttempt({ ...attempt, turnId: session.activeTurnId });
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
      case "thread.session-set":
        return activeThreadIds.has(event.payload.threadId)
          ? worker.enqueue({
              type: "session",
              threadId: event.payload.threadId,
              session: event.payload.session,
            })
          : Effect.void;
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
            threadId: null,
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
                ].join(" "),
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
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          for (const attempt of interrupted) {
            activeThreadIds.delete(attempt.providerThreadId);
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
      const subscription = yield* PubSub.subscribe(upserts);
      const current = yield* repository.listTasks({}).pipe(toPublic("subscribe"));
      return Stream.concat(
        Stream.fromIterable(current),
        Stream.fromSubscription(subscription),
      ).pipe(Stream.map((task) => ({ type: "upsert" as const, task })));
    }),
  );

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
    delegate,
    cancel,
    retry,
    get,
    list,
    subscribe,
    changes,
    start,
    ingestDomainEvent,
    sweep: worker.enqueue({ type: "sweep" }),
    drain: worker.drain,
  } satisfies PersonalTaskService["Service"];
});

export const layer = Layer.effect(PersonalTaskService, make);

/** The service with its own repositories; needs SqlClient, bots, engine and projections. */
export const layerLive = layer.pipe(
  Layer.provideMerge(PersonalTaskRepository.layer),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
);
