// Deciding that an attempt's turn has ended: the session watch, background work, provider waits and the sweep.
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  CommandId,
  ThreadId,
  type OrchestrationSession,
  type PersonalTask,
  type PersonalTaskAttempt,
} from "@t3tools/contracts";
import { type ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { isMissingProviderConversationText } from "../../provider/missingProviderConversation.ts";
import { LEASE_MINUTES, attemptMessageId, minutesFrom, type Changed } from "./taskShared.ts";
import {
  BACKGROUND_WAIT_PROVIDER,
  backgroundAttemptKey,
  heldReplyTexts,
  isWaitingOnBackground,
  newBackgroundWait,
  stepBackgroundWait,
  type BackgroundWait,
} from "./taskBackgroundPolicy.ts";
import {
  providerRetryOfAttempt,
  providerWaitMessage,
  providerWaitPause,
  settleSessionError,
  type ProviderWaitPause,
} from "./taskLimitPolicy.ts";
import {
  BACKGROUND_SESSION_ENDED_NOTE,
  backgroundCapNote,
  composeTaskReplies,
  withNote,
} from "./taskResultPolicy.ts";
import { isWaitingForUser, sessionIsAlive } from "./taskSessionPolicy.ts";
import type { TaskCore } from "./taskCore.ts";
import type { TaskDispatch } from "./taskDispatch.ts";

export const makeTaskSettling = (core: TaskCore, dispatch: TaskDispatch) => {
  const {
    activeAttemptForThread,
    backgroundByThread,
    botRepository,
    engine,
    leaseOwner,
    liveness,
    messages,
    publish,
    readSession,
    refreshActiveThreads,
    renewalWaitSince,
    repository,
    resumingThreadIds,
    snapshots,
    writeTask,
  } = core;
  const { finishAttempt, pump } = dispatch;

  // A waiting task with an undelivered resume note queues once its notes
  // allow: a note that needs a fresh provider process waits until the
  // thread's session is gone, so the next turn starts a new process (which
  // is when provider environments are built).
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
    const created = newBackgroundWait(key);
    backgroundByThread.set(attempt.providerThreadId, created);
    return created;
  };

  /** A turn of the attempt ended with background work left; the task still runs. */
  const waitingOnBackground = (attempt: PersonalTaskAttempt) =>
    isWaitingOnBackground(
      backgroundByThread.get(attempt.providerThreadId),
      backgroundAttemptKey(attempt),
    );

  /**
   * The attempt's result text: the replies of the turns that ended with
   * background work left, then `last` (the newest reply) unless it is one of
   * them. With no such turns this is just `last`'s text, as it always was.
   */
  const composeAttemptReplies = (
    attempt: PersonalTaskAttempt,
    last: ProjectionThreadMessage | undefined,
  ) =>
    composeTaskReplies(
      heldReplyTexts(
        backgroundByThread.get(attempt.providerThreadId),
        backgroundAttemptKey(attempt),
        last,
      ),
    );

  /**
   * While the task waits on background work, its replies so far go on the task
   * itself (still `running`, result marked with the time the wait began), so
   * get_task, list_tasks and the task screen show them straight away instead
   * of nothing until the work ends. Best effort: a failed write is logged.
   */
  const publishWaitingPreview = Effect.fn("PersonalTaskService.publishWaitingPreview")(function* (
    attempt: PersonalTaskAttempt,
    state: BackgroundWait,
  ) {
    const task = yield* repository.getTask(attempt.taskId);
    if (Option.isNone(task) || task.value.status !== "running") return;
    const changed: Changed = [];
    yield* writeTask(changed, task.value, {
      result: {
        summary: composeTaskReplies(state.replies.map((reply) => reply.text)),
        ...(state.waitingSince === null ? {} : { waitingOnBackgroundSince: state.waitingSince }),
      },
    });
    yield* publish(changed);
  });

  /**
   * Whether a Claude turn that just ended cleanly is the task's last. Claude
   * Code lets a turn end while commands it started in the background run on,
   * then runs a new turn by itself when they finish; the bot's report is in
   * that turn. So the attempt stays active while such work is live, remembers
   * the reply of every turn that ended with work left (`last` is the turn that
   * just ended), and finishes on the turn that ends after it. Returns "wait",
   * or the note to add to the result (empty when there is nothing to say).
   */
  const backgroundOutcome = Effect.fn("PersonalTaskService.backgroundOutcome")(function* (
    attempt: PersonalTaskAttempt,
    session: OrchestrationSession,
    last: ProjectionThreadMessage | undefined,
  ) {
    const pending =
      session.providerName === BACKGROUND_WAIT_PROVIDER
        ? liveness
            .getThreadLiveTaskIds(attempt.providerThreadId)
            .filter((taskId) => !backgroundFor(attempt).baseline.has(taskId))
        : [];
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const step = stepBackgroundWait(backgroundFor(attempt), {
      pending,
      sessionUpdatedAt: session.updatedAt,
      nowMs,
      last: last === undefined ? undefined : { messageId: last.messageId, text: last.text },
    });
    backgroundByThread.set(attempt.providerThreadId, step.state);
    if (step.kind === "wait") {
      if (step.started) {
        yield* Effect.logInfo("personal task waiting on background work", {
          taskId: attempt.taskId,
          threadId: attempt.providerThreadId,
          backgroundTasks: pending,
        });
      }
      if (step.publishPreview) {
        yield* publishWaitingPreview(attempt, step.state).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("personal task could not publish its waiting preview", {
              taskId: attempt.taskId,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }
      return "wait" as const;
    }
    if (step.capped) {
      yield* Effect.logWarning("personal task closed with background work still running", {
        taskId: attempt.taskId,
        threadId: attempt.providerThreadId,
        backgroundTasks: pending,
      });
      return backgroundCapNote(pending.length);
    }
    return "";
  });

  // The provider session a bot just moved off (its home, after a usage limit) reports
  // its end a moment after the switch: an error, a stop. That is the earlier attempt's
  // turn dying, not the attempt that started on the fallback, so it ends nothing.
  const fromSupersededSession = Effect.fn("PersonalTaskService.fromSupersededSession")(function* (
    attempt: PersonalTaskAttempt,
    session: OrchestrationSession,
  ) {
    if (session.providerInstanceId === undefined) return false;
    const task = yield* repository.getTask(attempt.taskId);
    if (Option.isNone(task)) return false;
    const states = yield* botRepository.listFallbackStates();
    const state = states.find((candidate) => candidate.botId === task.value.botId);
    return (
      state !== undefined &&
      state.fromInstanceId === session.providerInstanceId &&
      state.fallbackModel.instanceId !== state.fromInstanceId &&
      DateTime.toEpochMillis(attempt.startedAt) >= Date.parse(state.startedAt)
    );
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
    const renewalKey = `${attempt.taskId}:${attempt.attempt}`;
    // Any state after the lost-conversation error (the renewal starting) ends the wait.
    if (session.status !== "error") renewalWaitSince.delete(renewalKey);
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
        const note = yield* backgroundOutcome(attempt, session, last);
        if (note === "wait") {
          return;
        }
        yield* finishAttempt(attempt, {
          kind: "completed",
          summary: withNote(composeAttemptReplies(attempt, last), note),
        });
        return;
      }
      case "interrupted":
      case "stopped":
        if (!observed && !fresh) {
          return;
        }
        if (yield* fromSupersededSession(attempt, session)) {
          return;
        }
        // The session closed while the task only waited on background work:
        // the bot had already replied, so its replies are the result.
        if (session.status === "stopped" && waitingOnBackground(attempt)) {
          const last = yield* latestReply();
          yield* finishAttempt(attempt, {
            kind: "completed",
            summary: withNote(composeAttemptReplies(attempt, last), BACKGROUND_SESSION_ENDED_NOTE),
          });
          return;
        }
        yield* finishAttempt(attempt, { kind: "interrupted", message: session.lastError });
        return;
      case "error": {
        if (!observed && !fresh) {
          return;
        }
        if (yield* fromSupersededSession(attempt, session)) {
          return;
        }
        // The failed resume reports its error before the app's renewal starts the fresh
        // session: the renewal is the same attempt, so the error is not yet its end. The CLI
        // then exits and the stream fails with an error of its own: while the wait is open that
        // follow-on error belongs to the same failed resume. If no renewal follows, the error
        // counts once the wait is over (the sweep settles it). A limit's details arrive on the
        // turn's completion right after its error, so a limited task waits a moment for them.
        const now = yield* DateTime.now;
        const settlement = settleSessionError({
          lastError: session.lastError,
          lostConversation: isMissingProviderConversationText(session.lastError),
          renewalWaitSinceMs: renewalWaitSince.get(renewalKey),
          nowMs: DateTime.toEpochMillis(now),
          providerRetry: session.providerRetry,
          attemptStartedAtMs: DateTime.toEpochMillis(attempt.startedAt),
          activeTurnId: session.activeTurnId,
          sessionUpdatedAtMs: Date.parse(session.updatedAt),
        });
        if (settlement.kind === "wait") {
          if (settlement.renewalWaitSinceMs !== undefined) {
            renewalWaitSince.set(renewalKey, settlement.renewalWaitSinceMs);
          }
          return;
        }
        if (settlement.clearRenewalWait) renewalWaitSince.delete(renewalKey);
        yield* finishAttempt(attempt, {
          kind: "failed",
          category: settlement.category,
          message: session.lastError,
          ...(settlement.limit === undefined
            ? {}
            : {
                limit: {
                  provider: settlement.limit.provider,
                  instanceId: session.providerInstanceId,
                  reason: settlement.limit.reason,
                  retryAt: settlement.limit.retryAt,
                },
              }),
          ...(settlement.resetAtMs === undefined
            ? {}
            : { availableAt: DateTime.makeUnsafe(settlement.resetAtMs) }),
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
    const message = providerWaitMessage(pause);
    yield* finishAttempt(attempt, {
      kind: "failed",
      category: "rate_limited",
      message,
      ...(retry.kind === "rate_limited"
        ? { limit: { provider: retry.provider, reason: retry.reason, retryAt: retry.retryAt } }
        : {}),
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
        const pause = providerWaitPause(
          providerRetryOfAttempt(session.providerRetry, DateTime.toEpochMillis(attempt.startedAt)),
          DateTime.toEpochMillis(now),
        );
        if (pause !== null && !(yield* fromSupersededSession(attempt, session))) {
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

  return { observeSession, resumeWaiting, settle, sweepOnce, tryResume, waitingOnBackground };
};

export type TaskSettling = ReturnType<typeof makeTaskSettling>;
