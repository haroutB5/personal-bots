import { PersonalTask } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { foldPersonalTasksFeed } from "./usePersonalAutomation";
import { foldPersonalGroupsStream } from "./usePersonalGroups";

const decodeTask = Schema.decodeUnknownSync(PersonalTask);

function task(taskId: string): PersonalTask {
  return decodeTask({
    taskId,
    rootTaskId: taskId,
    parentTaskId: null,
    botId: "bot-assistant",
    threadId: "thread-parent",
    title: `Task ${taskId}`,
    objective: "Do it",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "running",
    source: "user",
    idempotencyKey: `key-${taskId}`,
    depth: 0,
    maxDepth: 2,
    maxChildren: 4,
    result: null,
    errorCategory: null,
    errorMessage: null,
    availableAt: null,
    createdAt: "2026-10-16T04:02:00.000Z",
    updatedAt: "2026-10-16T04:02:00.000Z",
    startedAt: null,
    completedAt: null,
  });
}

describe("foldPersonalTasksFeed", () => {
  // The Tasks page reads `null` as "still loading": a root with no tasks used to
  // hang on "Loading…" forever, because an empty replay produced no value at all.
  it.effect("emits the loaded empty map when the replay has no tasks", () =>
    Effect.gen(function* () {
      const values = [...(yield* Stream.runCollect(foldPersonalTasksFeed(Stream.empty)))];

      expect(values).toHaveLength(1);
      expect(values[0]?.size).toBe(0);
    }),
  );

  it.effect("folds the replay and live upserts onto that first empty map", () =>
    Effect.gen(function* () {
      const values = [
        ...(yield* Stream.runCollect(
          foldPersonalTasksFeed(
            Stream.fromIterable([
              { type: "upsert" as const, task: task("task-1") },
              { type: "upsert" as const, task: task("task-2") },
            ]),
          ),
        )),
      ];

      expect(values[0]?.size).toBe(0);
      expect([...(values.at(-1)?.keys() ?? [])]).toEqual(["task-1", "task-2"]);
    }),
  );
});

describe("foldPersonalGroupsStream", () => {
  it.effect("emits the loaded empty feed when the replay has no groups", () =>
    Effect.gen(function* () {
      const values = [...(yield* Stream.runCollect(foldPersonalGroupsStream(Stream.empty)))];

      expect(values).toHaveLength(1);
      expect(values[0]?.groups.size).toBe(0);
    }),
  );
});
