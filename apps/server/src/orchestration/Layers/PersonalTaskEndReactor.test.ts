import { PersonalTaskId, ThreadId, type PersonalTask } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { PersonalDesktop } from "../../personal/desktop/PersonalDesktop.ts";
import { PersonalTaskService } from "../../personal/tasks/PersonalTaskService.ts";
import { PersonalTaskEndReactorLive } from "./PersonalTaskEndReactor.ts";

describe("PersonalTaskEndReactor", () => {
  it.effect("releases the desktop when a task ends, and only then", () => {
    const released: string[] = [];
    return Effect.gen(function* () {
      const changes = yield* Queue.unbounded<PersonalTask>();
      const handled = yield* Deferred.make<void>();
      const layer = PersonalTaskEndReactorLive.pipe(
        Layer.provide(
          Layer.succeed(PersonalTaskService, {
            changes: Stream.fromQueue(changes),
          } as unknown as PersonalTaskService["Service"]),
        ),
        Layer.provide(
          Layer.succeed(PersonalDesktop, {
            threadTurnEnded: (threadId: string) =>
              Effect.sync(() => {
                released.push(threadId);
              }).pipe(Effect.andThen(Deferred.succeed(handled, undefined))),
          } as unknown as PersonalDesktop["Service"]),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(layer);
          // A live task keeps the PC; a terminal one with no chat has nothing
          // to release; the terminal one with a chat gives it back.
          yield* Queue.offer(changes, {
            taskId: PersonalTaskId.make("task-live"),
            threadId: ThreadId.make("thread-live"),
            status: "running",
          } as PersonalTask);
          yield* Queue.offer(changes, {
            taskId: PersonalTaskId.make("task-no-thread"),
            threadId: null,
            status: "cancelled",
          } as PersonalTask);
          yield* Queue.offer(changes, {
            taskId: PersonalTaskId.make("task-stopped"),
            threadId: ThreadId.make("thread-stopped"),
            status: "cancelled",
          } as PersonalTask);
          yield* Deferred.await(handled);
          expect(released).toEqual(["thread-stopped"]);
        }),
      );
    });
  });
});
