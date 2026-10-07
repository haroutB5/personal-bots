// Who a bot's tool call acts for: the caller's task, the turn-ownership window and the external slots.
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { PersonalTaskId, type PersonalTask, type PersonalTaskAttempt } from "@t3tools/contracts";
import {
  LEASE_MINUTES,
  PERSONAL_TASKS_DEFAULT_MAX_CHILDREN,
  PERSONAL_TASKS_DEFAULT_MAX_DEPTH,
  PERSONAL_TASK_TURN_OWNERSHIP_MS,
  minutesFrom,
  type WorkItem,
} from "./taskShared.ts";
import { isTerminal } from "./taskSessionPolicy.ts";
import type { TaskCore } from "./taskCore.ts";
import type { PersonalTaskService } from "./PersonalTaskService.ts";

export const makeTaskCallers = (
  core: TaskCore,
  concurrency: number,
  glue: { readonly worker: { readonly enqueue: (item: WorkItem) => Effect.Effect<void> } },
) => {
  const {
    activeAttemptForThread,
    activeThreadIds,
    externalSlots,
    fail,
    leaseOwner,
    lock,
    messages,
    publish,
    repository,
    requireLiveBot,
    settledThreadAtMs,
    toPublic,
  } = core;
  const { worker } = glue;

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

  const reserveExternalSlot: PersonalTaskService["Service"]["reserveExternalSlot"] = (key) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          if (externalSlots.has(key)) return true;
          const active = yield* repository.listActiveAttempts();
          if (active.length + externalSlots.size >= concurrency) return false;
          externalSlots.add(key);
          return true;
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("personal tasks could not count slots for outside work", {
                key,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );

  const releaseExternalSlot: PersonalTaskService["Service"]["releaseExternalSlot"] = (key) =>
    Effect.suspend(() =>
      externalSlots.delete(key) ? worker.enqueue({ type: "pump" }) : Effect.void,
    );

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

  return {
    ownsThreadTurn,
    releaseExternalSlot,
    reserveExternalSlot,
    resolveCallerTask,
    rootTaskIdForThread,
  };
};

export type TaskCallers = ReturnType<typeof makeTaskCallers>;
