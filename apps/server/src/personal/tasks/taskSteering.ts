// Steering an unfinished task and reopening a finished one.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import {
  CommandId,
  PersonalTaskId,
  type PersonalBotId,
  type PersonalTask,
} from "@t3tools/contracts";
import { botModelSelectionForThread } from "../botModelSelection.ts";
import { personalTaskSteerMessageId } from "../personalThreadTitles.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";
import { type Changed, type WorkItem } from "./taskShared.ts";
import { isTerminal, sessionIsBusy } from "./taskSessionPolicy.ts";
import { PERSONAL_TASK_REOPEN_NOTE_PREFIX, reopenNote, steerText } from "./taskTurnPolicy.ts";
import type { TaskCore } from "./taskCore.ts";
import type { TaskSettling } from "./taskSettling.ts";
import type { PersonalTaskService } from "./PersonalTaskService.ts";

export const makeTaskSteering = (
  core: TaskCore,
  settling: TaskSettling,
  glue: { readonly worker: { readonly enqueue: (item: WorkItem) => Effect.Effect<void> } },
) => {
  const {
    botRepository,
    carryExposureFromSteerer,
    engine,
    fail,
    lock,
    publish,
    recordWorkSteer,
    repository,
    requireLiveBotInTransaction,
    requireTask,
    snapshots,
    toPublic,
    writeTask,
  } = core;
  const { waitingOnBackground } = settling;
  const { worker } = glue;

  /** Whether a bot is live, read on the writing connection (see requireLiveBotInTransaction). */
  const botIsLive = (botId: PersonalBotId) =>
    requireLiveBotInTransaction(botId).pipe(
      Effect.as(true),
      Effect.catchTag("PersonalTasksError", () => Effect.succeed(false)),
    );

  /** Puts a task's handoff to its parent back to pending, so its next result returns. */
  const reopenHandoff = Effect.fn("PersonalTaskService.reopenHandoff")(function* (
    taskId: PersonalTaskId,
    now: DateTime.Utc,
  ) {
    const handoff = yield* repository.getHandoffByChild(taskId);
    if (Option.isSome(handoff) && handoff.value.status !== "pending") {
      yield* repository.writeHandoff({
        ...handoff.value,
        status: "pending",
        resultSummary: null,
        updatedAt: now,
      });
    }
  });

  /**
   * Reopens a finished task in its own chat: it is queued again on the same
   * thread (so the next attempt resumes the same provider session where the
   * provider allows), with the steer and a "continue where you stopped" note
   * as its continuation turn. No task is created, so the per-request
   * delegation limit is untouched, and the slot cap applies as to any queued
   * task.
   *
   * The result must reach whoever delegated the task. Its handoff goes back
   * to pending, and every finished ancestor up to the first unfinished one is
   * reopened as waiting_for_agent with its own handoff pending too. From there
   * it is the ordinary delegation path: the result wakes the parent with a
   * continuation in the parent's own chat (after any turn running there), the
   * parent answers and completes, and its answer climbs the same way. An
   * unfinished ancestor just gets the pending handoff and parks or continues
   * as usual. Refused when the task's bot, or the bot of an ancestor that
   * would have to reopen, has been deleted.
   */
  const reopen = Effect.fn("PersonalTaskService.reopen")(function* (
    task: PersonalTask,
    steerNoteId: string,
    steerId: string,
    text: string,
  ) {
    const ancestors: Array<PersonalTask> = [];
    let cursor = task;
    while (cursor.parentTaskId !== null) {
      const parent = yield* requireTask(cursor.parentTaskId);
      if (!isTerminal(parent.status)) break;
      ancestors.push(parent);
      cursor = parent;
    }
    const changed: Changed = [];
    const reopenPatch = {
      result: null,
      errorCategory: null,
      errorMessage: null,
      availableAt: null,
      completedAt: null,
    } satisfies Partial<PersonalTask>;
    const reopened = yield* repository.transaction(
      Effect.gen(function* () {
        if (!(yield* botIsLive(task.botId))) {
          return yield* fail(
            "That task's bot has been deleted, so the task cannot be reopened. Delegate a new task to another bot.",
          );
        }
        for (const ancestor of ancestors) {
          if (!(yield* botIsLive(ancestor.botId))) {
            return yield* fail(
              "The task this one reports to belongs to a deleted bot, so it cannot be reopened. Delegate a new task instead.",
            );
          }
        }
        const now = yield* DateTime.now;
        const queued = yield* writeTask(changed, task, { ...reopenPatch, status: "queued" });
        if (queued === null) {
          return yield* fail("That task changed while it was being reopened; try again.");
        }
        yield* reopenHandoff(task.taskId, now);
        for (const ancestor of ancestors) {
          const waiting = yield* writeTask(changed, ancestor, {
            ...reopenPatch,
            status: "waiting_for_agent",
          });
          if (waiting === null) {
            return yield* fail(
              "A task above this one changed while it was being reopened; try again.",
            );
          }
          yield* reopenHandoff(ancestor.taskId, now);
        }
        // The steer is recorded like any other (get_task lists it); the
        // reopen note follows it in the same continuation turn.
        yield* repository.insertResumeNote({
          noteId: steerNoteId,
          taskId: task.taskId,
          text,
          restartSession: false,
          createdAt: now,
        });
        yield* repository.insertResumeNote({
          noteId: `${PERSONAL_TASK_REOPEN_NOTE_PREFIX}${steerId}`,
          taskId: task.taskId,
          text: reopenNote(task.status),
          restartSession: false,
          createdAt: now,
        });
        return queued;
      }),
    );
    yield* publish(changed);
    yield* worker.enqueue({ type: "pump" });
    return reopened;
  });

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
          if (input.fromThreadId !== undefined) {
            yield* carryExposureFromSteerer(input.fromThreadId, task);
          }
          const now = yield* DateTime.now;
          const steerId = NodeCrypto.randomUUID().replaceAll("-", "");
          const noteId = `${PersonalTaskRepository.PERSONAL_TASK_STEER_NOTE_PREFIX}${steerId}`;
          const text = steerText(input.fromName, input.message);
          if (isTerminal(task.status)) {
            const reopened = yield* reopen(task, noteId, steerId, text);
            yield* recordWorkSteer(task, text);
            return { outcome: "reopened" as const, task: reopened, text };
          }
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
            yield* recordWorkSteer(task, text);
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
          yield* recordWorkSteer(task, text);
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

  return { steer, steers };
};

export type TaskSteering = ReturnType<typeof makeTaskSteering>;
