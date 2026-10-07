// Parking a task on the user or the shared browser, and bringing it back.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { CommandId, PersonalTaskId } from "@t3tools/contracts";
import { type Changed, type WorkItem } from "./taskShared.ts";
import { isWaitingForUser, sessionIsAlive } from "./taskSessionPolicy.ts";
import type { TaskCore } from "./taskCore.ts";
import type { TaskSettling } from "./taskSettling.ts";
import type { PersonalTaskService } from "./PersonalTaskService.ts";

export const makeTaskWaiting = (
  core: TaskCore,
  settling: TaskSettling,
  glue: { readonly worker: { readonly enqueue: (item: WorkItem) => Effect.Effect<void> } },
) => {
  const {
    engine,
    fail,
    lock,
    publish,
    readSession,
    repository,
    requireTask,
    resumingThreadIds,
    returnToParent,
    toPublic,
    writeTask,
  } = core;
  const { tryResume } = settling;
  const { worker } = glue;

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

  return { failWaitingForUser, resumeFromUser, waitForBrowser, waitForUser };
};

export type TaskWaiting = ReturnType<typeof makeTaskWaiting>;
