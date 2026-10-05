import { PersonalBotId, PersonalTaskId, type PersonalTask } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as PersonalTaskRepository from "./PersonalTaskRepository.ts";

const layer = PersonalTaskRepository.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const makeTask = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const taskId = PersonalTaskId.make("task-notify");
  return {
    taskId,
    rootTaskId: taskId,
    parentTaskId: null,
    botId: PersonalBotId.make("bot-a"),
    threadId: null,
    title: "Hourly check",
    objective: "Check.",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "running",
    source: "routine",
    idempotencyKey: "routine:r1:slot",
    depth: 0,
    maxDepth: 2,
    maxChildren: 4,
    result: null,
    errorCategory: null,
    errorMessage: null,
    availableAt: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
  } satisfies PersonalTask;
});

it.effect("a task starts with no mode, no decision and no message", () =>
  Effect.gen(function* () {
    const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
    const task = yield* makeTask;
    yield* repository.insertTask(task);
    expect(yield* repository.getNotifyState(task.taskId)).toEqual({
      mode: null,
      decision: null,
      message: null,
    });
    // A task that is not there reads the same, never an error.
    expect(yield* repository.getNotifyState(PersonalTaskId.make("missing"))).toEqual({
      mode: null,
      decision: null,
      message: null,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "the mode, then the last decision, are stored; ordinary task writes leave them alone",
  () =>
    Effect.gen(function* () {
      const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
      const task = yield* makeTask;
      yield* repository.insertTask(task);
      yield* repository.setNotifyMode(task.taskId, "bot_decides");
      yield* repository.recordNotifyDecision({
        taskId: task.taskId,
        notify: true,
        message: "First",
      });
      yield* repository.recordNotifyDecision({ taskId: task.taskId, notify: false, message: null });
      expect(yield* repository.getNotifyState(task.taskId)).toEqual({
        mode: "bot_decides",
        decision: false,
        message: null,
      });
      yield* repository.recordNotifyDecision({
        taskId: task.taskId,
        notify: true,
        message: "Last",
      });

      // The run ends: the status write must not clear what the bot said.
      const finished = {
        ...task,
        status: "completed",
        completedAt: task.createdAt,
      } satisfies PersonalTask;
      expect(yield* repository.writeTask(finished, "running")).toBe(true);
      expect(yield* repository.getNotifyState(task.taskId)).toEqual({
        mode: "bot_decides",
        decision: true,
        message: "Last",
      });
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "queueing a finished task again starts a new run: the old decision is cleared, the mode kept",
  () =>
    Effect.gen(function* () {
      const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
      const task = yield* makeTask;
      yield* repository.insertTask(task);
      yield* repository.setNotifyMode(task.taskId, "bot_decides");
      yield* repository.recordNotifyDecision({ taskId: task.taskId, notify: true, message: "Old" });
      yield* repository.writeTask({ ...task, status: "completed" }, "running");

      yield* repository.writeTask({ ...task, status: "queued", completedAt: null }, "completed");
      expect(yield* repository.getNotifyState(task.taskId)).toEqual({
        mode: "bot_decides",
        decision: null,
        message: null,
      });

      // Queued while merely waiting (not finished) keeps the call it already made.
      yield* repository.writeTask({ ...task, status: "running" }, "queued");
      yield* repository.recordNotifyDecision({ taskId: task.taskId, notify: true, message: "Mid" });
      yield* repository.writeTask({ ...task, status: "waiting_for_user" }, "running");
      yield* repository.writeTask({ ...task, status: "queued" }, "waiting_for_user");
      expect(yield* repository.getNotifyState(task.taskId)).toMatchObject({
        decision: true,
        message: "Mid",
      });
    }).pipe(Effect.provide(layer)),
);
