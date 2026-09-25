import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PersonalBotId, PersonalGroupId, ThreadId } from "@t3tools/contracts";

import { deletePersonalGroup } from "./deletePersonalGroup.ts";
import type { PersonalBotPurgeServices } from "./purgePersonalBot.ts";

const GROUP = PersonalGroupId.make("group-1");
const ada = PersonalBotId.make("bot-ada");
const grace = PersonalBotId.make("bot-grace");
const alan = PersonalBotId.make("bot-alan");
const stranger = PersonalBotId.make("bot-stranger");

/**
 * Fakes that record every destructive call, in order. The group's membership is
 * mutable so `purgeBot` really drops a row, the way the live service does.
 */
function makeServices(
  options: { readonly purgeFails?: string; readonly taskThreadId?: ThreadId } = {},
) {
  const calls: Array<string> = [];
  const record = (call: string) => Effect.sync(() => void calls.push(call));
  let members: Array<PersonalBotId> = [ada, grace, alan];

  const services = {
    bots: {
      list: () =>
        Effect.succeed({
          bots: [],
          // The bot's own chats, independent of any group membership.
          threads: [ada, grace, alan, stranger].map((botId) => ({
            botId,
            threadId: ThreadId.make(`thread-${botId}`),
          })),
        }),
      remove: ({ botId }: { botId: string }) =>
        options.purgeFails === botId
          ? Effect.fail({ _tag: "BotRemoveFailed" as const })
          : record(`bot:${botId}`),
    },
    tasks: {
      list: () =>
        Effect.succeed({
          tasks: options.taskThreadId
            ? [{ taskId: "task-1", threadId: options.taskThreadId, status: "running" }]
            : [],
        }),
      cancel: ({ taskId }: { taskId: string }) => record(`task:${taskId}`),
    },
    routines: { list: () => Effect.succeed({ routines: [] }), remove: () => Effect.void },
    memory: { list: () => Effect.succeed([]), remove: () => Effect.void },
    secrets: {
      listPending: () => Effect.succeed({ requests: [] }),
      cancel: () => Effect.void,
      list: () => Effect.succeed({ secrets: [] }),
      remove: () => Effect.void,
    },
    engine: {
      dispatch: (command: { type: string; threadId: string }) =>
        record(`${command.type}:${command.threadId}`),
    },
    groups: {
      list: () =>
        Effect.succeed({
          groups: [
            {
              groupId: GROUP,
              members: members.map((botId, index) => ({
                botId,
                sortOrder: index,
                threadId: ThreadId.make(`group-thread-${botId}`),
              })),
            },
          ],
          rounds: [],
          votes: [],
        }),
      stop: ({ groupId }: { groupId: string }) => record(`stop:${groupId}`),
      remove: ({ groupId }: { groupId: string }) => record(`group:${groupId}`),
      purgeBot: ({ botId }: { botId: PersonalBotId }) =>
        Effect.suspend(() => {
          members = members.filter((entry) => entry !== botId);
          return record(`groups:${botId}`);
        }),
    },
  } as unknown as PersonalBotPurgeServices;

  return { calls, services, membersNow: () => members };
}

/** An empty group list: the group is already gone. */
function makeGoneServices() {
  const { calls, services } = makeServices();
  return {
    calls,
    services: {
      ...services,
      groups: {
        ...services.groups,
        list: () => Effect.succeed({ groups: [], rounds: [], votes: [] }),
      },
    } as unknown as PersonalBotPurgeServices,
  };
}

describe("deletePersonalGroup", () => {
  it.effect("purges only the ticked bots, stops the round first and deletes the group last", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices();

      yield* deletePersonalGroup(services, { groupId: GROUP, purgeBotIds: [alan, ada] });

      assert.deepEqual(calls, [
        // The live round goes before anything it holds is deleted.
        `stop:${GROUP}`,
        // Member order, not the order the client sent (alan, ada).
        `groups:${ada}`,
        `thread.delete:thread-${ada}`,
        `bot:${ada}`,
        `groups:${alan}`,
        `thread.delete:thread-${alan}`,
        `bot:${alan}`,
        // The group is last, and only after every purge succeeded.
        `group:${GROUP}`,
      ]);
      // Grace was not ticked: nothing of hers was touched.
      assert.notInclude(calls, `bot:${grace}`);
      assert.notInclude(calls, `thread.delete:thread-${grace}`);
    }),
  );

  it.effect("deletes the group only when nothing is ticked, exactly as before", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices();

      yield* deletePersonalGroup(services, { groupId: GROUP });

      assert.deepEqual(calls, [`stop:${GROUP}`, `group:${GROUP}`]);
    }),
  );

  it.effect("treats an empty tick list the same as no list at all", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices();

      yield* deletePersonalGroup(services, { groupId: GROUP, purgeBotIds: [] });

      assert.deepEqual(calls, [`stop:${GROUP}`, `group:${GROUP}`]);
    }),
  );

  it.effect("cancels work on member chats before deleting their group", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices({
        taskThreadId: ThreadId.make(`group-thread-${grace}`),
      });

      yield* deletePersonalGroup(services, { groupId: GROUP });

      assert.deepEqual(calls, [`stop:${GROUP}`, "task:task-1", `group:${GROUP}`]);
    }),
  );

  it.effect("refuses a bot that is not a member, and touches nothing at all", () =>
    Effect.gen(function* () {
      const { calls, services } = makeServices();

      const refused = yield* Effect.flip(
        deletePersonalGroup(services, { groupId: GROUP, purgeBotIds: [ada, stranger] }),
      );

      assert.include(refused.message, stranger);
      // Refused BEFORE the round was stopped: a refused delete has no effects,
      // and in particular Ada - who was a real member - is untouched.
      assert.deepEqual(calls, []);
    }),
  );

  it.effect("keeps the group when one purge fails part-way", () =>
    Effect.gen(function* () {
      const { calls, services, membersNow } = makeServices({ purgeFails: grace });

      yield* Effect.flip(
        deletePersonalGroup(services, { groupId: GROUP, purgeBotIds: [ada, grace, alan] }),
      );

      // Ada is gone, Grace failed, Alan was never started, and the group
      // survives so the owner can see what is left and try again.
      assert.include(calls, `bot:${ada}`);
      assert.notInclude(calls, `bot:${alan}`);
      assert.notInclude(calls, `thread.delete:thread-${alan}`);
      assert.notInclude(calls, `group:${GROUP}`);
      assert.deepEqual(membersNow(), [alan]);
    }),
  );

  it.effect("is a no-op on a group that is already gone", () =>
    Effect.gen(function* () {
      const { calls, services } = makeGoneServices();

      yield* deletePersonalGroup(services, { groupId: GROUP });

      assert.deepEqual(calls, []);
    }),
  );

  it.effect("refuses to purge bots for a group that is already gone", () =>
    Effect.gen(function* () {
      const { calls, services } = makeGoneServices();

      yield* Effect.flip(deletePersonalGroup(services, { groupId: GROUP, purgeBotIds: [ada] }));

      assert.deepEqual(calls, []);
    }),
  );
});
