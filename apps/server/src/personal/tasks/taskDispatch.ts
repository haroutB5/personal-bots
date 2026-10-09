// Starting and ending an attempt: the claim, the opening turn and the pump that fills free slots.
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  CommandId,
  ThreadId,
  type PersonalBotId,
  type PersonalHandoff,
  type PersonalTask,
  type PersonalTaskAttempt,
  type PersonalTaskMessageMarker,
} from "@t3tools/contracts";
import { resolveDeliveryThread } from "../automaticDelivery.ts";
import { botModelSelectionForThread } from "../botModelSelection.ts";
import { rootExposureKey } from "../browser/sensitiveExposureStore.ts";
import { personalTaskThreadTitle } from "../personalThreadTitles.ts";
import {
  estimateTokens,
  renderWorkRecord,
  reopenFreshTokens,
  workRecordHasContent,
} from "./workRecord.ts";
import {
  LEASE_MINUTES,
  attemptMessageId,
  minutesFrom,
  personalTaskMessageContext,
  type AttemptOutcome,
  type Changed,
} from "./taskShared.ts";
import { backgroundAttemptKey, newBackgroundWait } from "./taskBackgroundPolicy.ts";
import {
  classifyProviderError,
  consecutiveRateLimited,
  immediateRateLimitRetry,
  rateLimitBackoffMinutes,
} from "./taskLimitPolicy.ts";
import { withoutWaitingMarker } from "./taskResultPolicy.ts";
import { sessionIsBusy } from "./taskSessionPolicy.ts";
import {
  PERSONAL_TASK_REOPEN_NOTE_PREFIX,
  delegationContinuationText,
  notesContinuationText,
  openingTurnHeader,
  openingTurnText,
  sourceLabel,
  taskSections,
} from "./taskTurnPolicy.ts";
import type { TaskCore } from "./taskCore.ts";

export const makeTaskDispatch = (core: TaskCore, concurrency: number) => {
  const {
    activeThreadIds,
    backgroundByThread,
    botRepository,
    bots,
    continuesExistingChat,
    engine,
    persistExposureOnChat,
    externalSlots,
    idleWaitThreadIds,
    latestContextTokens,
    leaseOwner,
    liveness,
    modelFallback,
    publish,
    readSession,
    readWorkRecord,
    releaseThread,
    repository,
    resolveAfterTurn,
    returnToParent,
    snapshots,
    writeTask,
  } = core;

  const finishAttempt = Effect.fn("PersonalTaskService.finishAttempt")(function* (
    attempt: PersonalTaskAttempt,
    outcome: AttemptOutcome,
  ) {
    const changed: Changed = [];
    // A usage limit the provider reported: the bot moves to its fallback model
    // (when it has one with room) and the task runs again at once instead of
    // waiting for the reset. Decided before the transaction: it writes a chat
    // line through the orchestration engine.
    const fallbackHit =
      outcome.kind === "failed" &&
      outcome.category === "rate_limited" &&
      outcome.limit !== undefined &&
      Option.isSome(modelFallback)
        ? yield* repository.getTask(attempt.taskId).pipe(
            Effect.flatMap((task) =>
              Option.isNone(task) || task.value.status !== "running"
                ? Effect.succeed(undefined)
                : modelFallback.value.onLimitHit({
                    botId: task.value.botId,
                    threadId: attempt.providerThreadId,
                    source: "task",
                    instanceId: outcome.limit?.instanceId,
                    providerName: outcome.limit?.provider,
                    reason: outcome.limit?.reason,
                    retryAt: outcome.limit?.retryAt,
                  }),
            ),
          )
        : undefined;
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
          // The model fallback took over (run again at once), or a reported reset is
          // honest about the wait and is used as-is, rather than spending the
          // unreported-limit backoff budget.
          const immediate = immediateRateLimitRetry({
            fallbackSwitched: fallbackHit?.switched === true,
            reportedResetMs:
              outcome.availableAt === undefined
                ? null
                : DateTime.toEpochMillis(outcome.availableAt),
            nowMs: DateTime.toEpochMillis(now),
          });
          if (immediate !== null) {
            yield* writeTask(changed, task.value, {
              status: "rate_limited",
              result: withoutWaitingMarker(task.value.result),
              availableAt:
                immediate.kind === "run_now"
                  ? now
                  : (outcome.availableAt ?? DateTime.makeUnsafe(immediate.availableAtMs)),
              errorCategory: "rate_limited",
              errorMessage: outcome.message,
            });
            return;
          }
          const attempts = yield* repository.listAttempts(attempt.taskId);
          const backoff = rateLimitBackoffMinutes(
            consecutiveRateLimited(attempts.map((entry) => entry.errorCategory)),
          );
          if (backoff !== undefined) {
            yield* writeTask(changed, task.value, {
              status: "rate_limited",
              result: withoutWaitingMarker(task.value.result),
              availableAt: minutesFrom(now, backoff),
              errorCategory: "rate_limited",
              errorMessage: outcome.message,
            });
            return;
          }
        }
        const ended = yield* writeTask(changed, task.value, {
          status: outcome.kind === "interrupted" ? "interrupted" : "failed",
          result: withoutWaitingMarker(task.value.result),
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
    stillRunning: ReadonlyArray<PersonalHandoff>,
    freshRecord: string | null = null,
  ) {
    const marker = (
      turn: PersonalTaskMessageMarker["turn"],
      delegatorBotId: PersonalBotId | null,
      children: PersonalTaskMessageMarker["children"],
    ): PersonalTaskMessageMarker => ({
      ...(freshRecord === null ? {} : { fresh: true }),
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
        text: delegationContinuationText({
          results: results.map((result) => result.text),
          stillRunningTitles: stillRunning.map((handoff) => handoff.brief.title),
          notes,
          sections: taskSections(task, null),
        }),
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
        text: notesContinuationText({ notes, freshRecord, sections: taskSections(task, null) }),
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
    return {
      text: openingTurnText({
        header: openingTurnHeader(sourceLabel(task, delegatorName), attemptNumber),
        sections: taskSections(task, Option.isSome(handoff) ? handoff.value.brief : null),
        notes,
      }),
      marker: marker(attemptNumber > 1 ? "retry" : "start", delegatorBotId, []),
    };
  });

  // Creates the bot thread on first use and starts the turn. Deterministic
  // command and message ids make a repeated start of one attempt dedupe on
  // the orchestration command receipt.
  /**
   * The work record to seed a fresh session with, or null when the turn
   * resumes the session as before: only a reopened task with something in its
   * record whose chat the provider last reported at or above
   * `reopenFreshTokens()` (default 60,000; 0 or "off" never).
   */
  const freshStartRecord = Effect.fn("PersonalTaskService.freshStartRecord")(function* (
    task: PersonalTask,
    attempt: PersonalTaskAttempt,
    delivered: ReadonlyArray<PersonalHandoff>,
    reopened: boolean,
  ) {
    const threshold = reopenFreshTokens();
    if (!reopened || threshold <= 0 || delivered.length > 0) return null;
    // A task continuing the owner's own conversation keeps that conversation in
    // its session on a reopen: the point of handing work into the chat is that the
    // bot remembers it, and a work record would not carry the earlier talk.
    if (yield* continuesExistingChat(task)) return null;
    const record = yield* readWorkRecord(task.taskId).pipe(Effect.orElseSucceed(() => null));
    if (record === null || !workRecordHasContent(record)) return null;
    const used = yield* latestContextTokens(attempt.providerThreadId);
    if (used === null) {
      // Said once per reopen, so a resume that looks like it should have been fresh is explained.
      yield* Effect.logInfo(
        "personal task reopened and resumed: the provider reported no context size for this chat",
        {
          taskId: task.taskId,
          threadId: attempt.providerThreadId,
          threshold,
        },
      );
      return null;
    }
    if (used < threshold) return null;
    const text = renderWorkRecord(record);
    yield* Effect.logInfo("personal task reopened on a fresh session", {
      taskId: task.taskId,
      threadId: attempt.providerThreadId,
      contextTokens: used,
      seedTokens: estimateTokens(text),
    });
    return text;
  });

  const startTurn = Effect.fn("PersonalTaskService.startTurn")(function* (
    task: PersonalTask,
    attempt: PersonalTaskAttempt,
    delivered: ReadonlyArray<PersonalHandoff>,
    notes: ReadonlyArray<string>,
    stillRunning: ReadonlyArray<PersonalHandoff>,
    reopened = false,
  ) {
    // A reopened task whose chat has grown long starts a fresh provider
    // session seeded with its work record: every step of a long session
    // re-reads all of it. The bot reads older chat on demand (read_chat_history).
    const freshRecord = yield* freshStartRecord(task, attempt, delivered, reopened);
    const { text, marker } = yield* buildTurnText(
      task,
      attempt.attempt,
      delivered,
      notes,
      stillRunning,
      freshRecord,
    );
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

  /**
   * The chat this task's next turn goes to. Normally its own. A task that
   * lives in a conversation (a chat request the bot is waiting on children
   * for, or a routine posting into its chat) must not bring that chat back
   * once the owner archived it (1.66.8): it goes to the bot's open chat with
   * the same title instead, and the task is bound there from now on. A
   * delegated task's own chat is its work item, so it stays where it is (a
   * reopen or retry there is the task's own session, not a message to the
   * owner). A bot with no open chat gets a new one, made by `startTurn`.
   */
  const deliveryThreadFor = Effect.fn("PersonalTaskService.deliveryThreadFor")(function* (
    task: PersonalTask,
  ) {
    if (task.threadId === null || (task.source !== "user" && task.source !== "routine")) {
      return { threadId: task.threadId, note: null };
    }
    // A group member's relay thread is the group's transcript, not a chat the
    // owner archives or has a "next chat" for: nothing is judged or moved there.
    const groupRelay = yield* botRepository
      .isGroupRelay({ threadId: task.threadId })
      .pipe(Effect.orElseSucceed(() => false));
    if (groupRelay) return { threadId: task.threadId, note: null };
    const target = yield* resolveDeliveryThread(
      { repository: botRepository, projections: snapshots },
      task.threadId,
      // A routine's output only goes to a chat of the same name (as at creation).
      // A task on a chat that was deleted is cancelled with it; only a live link is judged.
      { sameTitleOnly: task.source === "routine", archivedOnly: true },
    ).pipe(Effect.orElseSucceed(() => ({ kind: "unknown" }) as const));
    if (target.kind === "open" || target.kind === "unknown") {
      return { threadId: task.threadId, note: null };
    }
    // The chat the resolver chose must belong to the task's own bot. It always
    // does while the data is consistent (the resolver looks at the source chat's
    // bot); if a task and its chat ever disagree, nothing is redirected and the
    // task stays where it was, rather than putting one bot's work in another's chat.
    const targetBotId =
      target.kind === "redirect"
        ? yield* botRepository.getThreadLink({ threadId: target.threadId }).pipe(
            Effect.map((link) => (Option.isSome(link) ? link.value.botId : null)),
            Effect.orElseSucceed(() => null),
          )
        : target.botId;
    if (targetBotId !== task.botId) {
      yield* Effect.logWarning("personal task delivery refused: the chat belongs to another bot", {
        taskId: task.taskId,
        threadId: task.threadId,
        taskBotId: task.botId,
        chatBotId: targetBotId,
      });
      return { threadId: task.threadId, note: null };
    }
    return target.kind === "redirect"
      ? { threadId: target.threadId, note: target.reason }
      : { threadId: ThreadId.make(NodeCrypto.randomUUID()), note: "new-chat" as const };
  });

  const claim = Effect.fn("PersonalTaskService.claim")(function* (
    task: PersonalTask,
    deliveryThreadId: ThreadId | null,
  ) {
    const changed: Changed = [];
    const claimed = yield* repository.transaction(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const threadId = deliveryThreadId ?? ThreadId.make(NodeCrypto.randomUUID());
        const running = yield* writeTask(changed, task, {
          status: "running",
          threadId,
          result: withoutWaitingMarker(task.result),
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
        const stillRunning = handoffs.filter((handoff) => handoff.status === "pending");
        return {
          task: running,
          attempt,
          delivered,
          notes: notes.map((note) => note.text),
          stillRunning,
          // The attempt continues a task that had finished and was steered.
          reopened: notes.some((note) => note.noteId.startsWith(PERSONAL_TASK_REOPEN_NOTE_PREFIX)),
        };
      }),
    );
    if (claimed !== null) {
      const threadId = claimed.attempt.providerThreadId;
      activeThreadIds.add(threadId);
      // Work already live in the chat (left by an earlier attempt or by the
      // user's own turn) is not this attempt's to wait for.
      backgroundByThread.set(
        threadId,
        newBackgroundWait(
          backgroundAttemptKey(claimed.attempt),
          new Set(liveness.getThreadLiveTaskIds(threadId)),
        ),
      );
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
      if (active.length + externalSlots.size >= concurrency) {
        return;
      }
      const busyThreads = new Set<string>(active.map((attempt) => attempt.providerThreadId));
      const candidates = yield* repository.listClaimable(yield* DateTime.now);
      // A task bound to a thread also waits while a turn nobody's task owns
      // runs there (the user chatting in that chat): starting now would land
      // in the middle of it. It stays queued, so it still counts as unfinished.
      let next: PersonalTask | undefined;
      let nextThreadId: ThreadId | null = null;
      let nextNote: string | null = null;
      idleWaitThreadIds.clear();
      for (const task of candidates) {
        if (task.threadId === null) {
          next = task;
          break;
        }
        const delivery = yield* deliveryThreadFor(task);
        const threadId = delivery.threadId;
        if (threadId === null) continue;
        if (busyThreads.has(threadId)) continue;
        if (yield* heldByOtherTurn(task, threadId)) {
          idleWaitThreadIds.add(threadId);
          continue;
        }
        // A task continuing the owner's chat leaves whatever reaches it (a child's result,
        // a steer, a reopen) in a chat that outlives the request, so the tree's marks go
        // onto the chat before its turn starts. Fails closed: a task whose chat cannot be
        // marked stays queued and is tried again at the next pump.
        if (task.source === "delegation") {
          const marked = yield* persistExposureOnChat(
            [rootExposureKey(task.rootTaskId)],
            threadId,
            "The chat's sensitive-site mark could not be written.",
          ).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning(
                    "personal task waits: its chat could not take the tree's sensitive-site mark",
                    {
                      taskId: task.taskId,
                      cause: Cause.pretty(cause).slice(0, 1_000),
                    },
                  ).pipe(Effect.as(false)),
            ),
          );
          if (!marked) continue;
        }
        next = task;
        nextThreadId = threadId;
        nextNote = delivery.note;
        break;
      }
      if (next === undefined) {
        return;
      }
      const claimed = yield* claim(next, nextThreadId);
      if (claimed === null) {
        continue;
      }
      if (nextNote !== null) {
        yield* Effect.logInfo(
          nextNote === "new-chat"
            ? "personal task goes to a new chat: its chat is archived or gone and the bot has none open"
            : "personal task goes to the bot's open chat: its chat is archived or gone",
          {
            taskId: claimed.task.taskId,
            from: next.threadId,
            threadId: claimed.attempt.providerThreadId,
            reason: nextNote,
          },
        );
      }
      yield* startTurn(
        claimed.task,
        claimed.attempt,
        claimed.delivered,
        claimed.notes,
        claimed.stillRunning,
        claimed.reopened,
      ).pipe(
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

  return { finishAttempt, pump };
};

export type TaskDispatch = ReturnType<typeof makeTaskDispatch>;
