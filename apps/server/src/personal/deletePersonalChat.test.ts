import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ThreadId } from "@t3tools/contracts";

import { deletePersonalChat, type PersonalChatDeleteServices } from "./deletePersonalChat.ts";

const deleted = ThreadId.make("thread-deleted");
const other = ThreadId.make("thread-other");

/** Fakes that record, in order, every call the delete makes. */
function makeServices() {
  const calls: Array<string> = [];
  const record = (call: string) => Effect.sync(() => void calls.push(call));
  const services = {
    bots: {
      deleteThread: ({ threadId }: { threadId: string }) => record(`thread:${threadId}`),
    },
    tasks: {
      list: () =>
        Effect.succeed({
          tasks: [
            // The delegating root: parked on its child, still owning the chat.
            { taskId: "task-waiting", threadId: deleted, status: "waiting_for_agent" },
            { taskId: "task-running", threadId: deleted, status: "running" },
            // Finished work keeps its outcome; it can never re-claim the id.
            { taskId: "task-done", threadId: deleted, status: "completed" },
            // Another chat's work is untouched.
            { taskId: "task-elsewhere", threadId: other, status: "running" },
            // A queued task with no thread yet cannot be this chat's.
            { taskId: "task-unassigned", threadId: null, status: "queued" },
          ],
        }),
      cancel: ({ taskId }: { taskId: string }) => record(`cancel:${taskId}`),
    },
  } as unknown as PersonalChatDeleteServices;
  return { calls, services };
}

describe("deletePersonalChat", () => {
  it.effect("stops the chat's live tasks before deleting the thread", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices();

      yield* deletePersonalChat(services, deleted);

      // Order matters: a task left alive keeps `threadId`, so the dispatcher
      // would re-claim the id and start a provider turn on the tombstone.
      assert.deepEqual(calls, ["cancel:task-waiting", "cancel:task-running", `thread:${deleted}`]);
    }),
  );

  it.effect("still deletes the chat when a task cancel fails", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices();
      const failing = {
        ...services,
        tasks: {
          ...services.tasks,
          cancel: () => Effect.fail({ _tag: "TaskGone" as const }),
        },
      } as unknown as PersonalChatDeleteServices;

      yield* deletePersonalChat(failing, deleted);

      assert.deepEqual(calls, [`thread:${deleted}`]);
    }),
  );

  it.effect("surfaces a failed thread delete so the chat stays listed for a retry", () =>
    Effect.gen(function* () {
      const { services } = makeServices();
      const failing = {
        ...services,
        bots: { deleteThread: () => Effect.fail({ _tag: "DispatchFailed" as const }) },
      } as unknown as PersonalChatDeleteServices;

      const error = yield* Effect.flip(deletePersonalChat(failing, deleted));

      expect(error).toEqual({ _tag: "DispatchFailed" });
    }),
  );
});
