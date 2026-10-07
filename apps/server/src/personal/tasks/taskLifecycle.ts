// Creating, relaying, delegating, cancelling and retrying tasks.
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  CommandId,
  MessageId,
  PERSONAL_TASK_RETRYABLE_STATUSES,
  PersonalTaskId,
  ThreadId,
  type PersonalTask,
  type PersonalTaskAttempt,
} from "@t3tools/contracts";
import {
  PERSONAL_TASKS_DEFAULT_MAX_CHILDREN,
  PERSONAL_TASKS_DEFAULT_MAX_DEPTH,
  type Changed,
  type WorkItem,
} from "./taskShared.ts";
import { isTerminal } from "./taskSessionPolicy.ts";
import type { TaskCore } from "./taskCore.ts";
import type { PersonalTaskService } from "./PersonalTaskService.ts";

export const makeTaskLifecycle = (
  core: TaskCore,
  glue: { readonly worker: { readonly enqueue: (item: WorkItem) => Effect.Effect<void> } },
) => {
  const {
    bots,
    carryExposureToTree,
    engine,
    fail,
    lock,
    publish,
    releaseThread,
    repository,
    requireLiveBot,
    requireLiveBotInTransaction,
    requireTask,
    returnToParent,
    toPublic,
    writeTask,
  } = core;
  const { worker } = glue;

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
          const inserted = yield* repository.transaction(
            Effect.gen(function* () {
              yield* requireLiveBotInTransaction(input.botId);
              const wasInserted = yield* repository.insertTask(task);
              if (wasInserted && input.notifyMode !== undefined) {
                yield* repository.setNotifyMode(taskId, input.notifyMode);
              }
              return wasInserted;
            }),
          );
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
          const inserted = yield* repository.transaction(
            Effect.gen(function* () {
              yield* requireLiveBotInTransaction(input.botId);
              const wasInserted = yield* repository.insertTask(task);
              if (wasInserted && input.notifyMode !== undefined) {
                yield* repository.setNotifyMode(taskId, input.notifyMode);
              }
              return wasInserted;
            }),
          );
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
          yield* carryExposureToTree(parent, root);
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
              yield* requireLiveBotInTransaction(input.targetBotId);
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

  return { cancel, createTask, delegate, relay, retry };
};

export type TaskLifecycle = ReturnType<typeof makeTaskLifecycle>;
