import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PersonalBotId, ThreadId } from "@t3tools/contracts";

import { type PersonalBotPurgeServices, purgePersonalBot } from "./purgePersonalBot.ts";

const bot = PersonalBotId.make("bot-gone");
const other = PersonalBotId.make("bot-kept");

/** Fakes that record every destructive call the purge makes. */
function makeServices() {
  const calls: Array<string> = [];
  const record = (call: string) => Effect.sync(() => void calls.push(call));
  const services = {
    bots: {
      list: () =>
        Effect.succeed({
          bots: [],
          threads: [
            { botId: bot, threadId: ThreadId.make("thread-gone") },
            { botId: other, threadId: ThreadId.make("thread-kept") },
          ],
        }),
      remove: ({ botId }: { botId: string }) => record(`bot:${botId}`),
    },
    tasks: {
      list: ({ botId }: { botId?: string }) =>
        Effect.succeed({
          tasks:
            botId === bot
              ? [
                  { taskId: "task-running", status: "running" },
                  { taskId: "task-done", status: "completed" },
                ]
              : [],
        }),
      cancel: ({ taskId }: { taskId: string }) => record(`cancel:${taskId}`),
    },
    routines: {
      list: () =>
        Effect.succeed({
          routines: [
            { routineId: "routine-gone", botId: bot },
            { routineId: "routine-kept", botId: other },
          ],
        }),
      remove: ({ routineId }: { routineId: string }) => record(`routine:${routineId}`),
    },
    memory: {
      list: (input: { scope?: string; scopeId?: string }) =>
        Effect.succeed(
          input.scope === "bot" && input.scopeId === bot ? [{ memoryId: "memory-gone" }] : [],
        ),
      remove: ({ memoryId }: { memoryId: string }) => record(`memory:${memoryId}`),
    },
    secrets: {
      listPending: () =>
        Effect.succeed({
          requests: [
            { requestId: "request-gone", botId: bot, status: "pending" },
            { requestId: "request-kept", botId: other, status: "pending" },
          ],
        }),
      cancel: ({ requestId }: { requestId: string }) => record(`request:${requestId}`),
      list: () =>
        Effect.succeed({
          secrets: [
            { name: "ONLY_GONE", botIds: [bot], shared: false },
            { name: "BOTH", botIds: [bot, other], shared: false },
            { name: "SHARED", botIds: [bot], shared: true },
          ],
        }),
      remove: ({ name }: { name: string }) => record(`secret:${name}`),
    },
    engine: {
      dispatch: (command: { type: string; threadId: string }) =>
        command.threadId === "thread-gone"
          ? record(`${command.type}:${command.threadId}`)
          : Effect.fail({ _tag: "UnexpectedThread" as const }),
    },
  } as unknown as PersonalBotPurgeServices;
  return { calls, services };
}

describe("purgePersonalBot", () => {
  it.effect("removes only what belongs to the bot, then the bot itself", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices();

      yield* purgePersonalBot(services, bot);

      assert.deepEqual(calls, [
        "cancel:task-running",
        "request:request-gone",
        "routine:routine-gone",
        "thread.delete:thread-gone",
        "memory:memory-gone",
        "secret:ONLY_GONE",
        `bot:${bot}`,
      ]);
    }),
  );

  it.effect("still deletes the bot when a cleanup step fails", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices();
      const failing = {
        ...services,
        routines: {
          ...services.routines,
          remove: () => Effect.fail({ _tag: "DiskFull" as const }),
        },
      } as unknown as PersonalBotPurgeServices;

      yield* purgePersonalBot(failing, bot);

      assert.include(calls, `bot:${bot}`);
      assert.include(calls, "thread.delete:thread-gone");
    }),
  );
});
