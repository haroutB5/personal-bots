import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PersonalBotId,
  PersonalBotsError,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { archivePersonalChats, deletePersonalChats } from "./bulkPersonalChats.ts";
import { deletePersonalChat, type PersonalChatDeleteServices } from "./deletePersonalChat.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";

const quiet = ThreadId.make("thread-quiet");
const working = ThreadId.make("thread-working");
const member = ThreadId.make("thread-group-member");
const delegating = ThreadId.make("thread-delegating");
const kept = ThreadId.make("thread-kept");

/** The real bot service over an in-memory database; the engine records what it is sent. */
const makeLayer = (dispatched: Array<OrchestrationCommand>) =>
  PersonalBotService.layer.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderRegistry.ProviderRegistry, {
        getProviders: Effect.succeed([]),
      } as unknown as ProviderRegistry.ProviderRegistryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        // The working chat's session is mid-turn; the others have none.
        getThreadShellById: (threadId: ThreadId) =>
          Effect.succeed(
            threadId === working
              ? Option.some({ id: working, session: { threadId: working, status: "running" } })
              : Option.none(),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-bulk-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

/** Fake task and group services around the real bot service, recording every cancel. */
const makeServices = (bots: PersonalBotService.PersonalBotService["Service"]) => {
  const cancels: Array<string> = [];
  const services = {
    bots,
    tasks: {
      list: () =>
        Effect.succeed({
          tasks: [
            { taskId: "task-running", threadId: working, status: "running" },
            { taskId: "task-parked", threadId: delegating, status: "waiting_for_agent" },
            { taskId: "task-done", threadId: quiet, status: "completed" },
            { taskId: "task-kept", threadId: kept, status: "running" },
          ],
        }),
      cancel: ({ taskId }: { taskId: string }) => Effect.sync(() => void cancels.push(taskId)),
    },
    groups: {
      groupNameForMemberThread: (threadId: string) =>
        Effect.succeed(threadId === member ? Option.some("Launch crew") : Option.none()),
    },
  } as unknown as PersonalChatDeleteServices;
  return { cancels, services };
};

/** A bot with five linked chats; returns every personal table's rows afterwards. */
const seed = Effect.gen(function* () {
  const bots = yield* PersonalBotService.PersonalBotService;
  const bot = yield* bots.create({
    botId: PersonalBotId.make("bot-bulk"),
    name: "Bulk",
    title: "",
    description: "",
    instructions: "",
    avatarShape: "blob",
    avatarColor: "#1A73E8",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
  });
  for (const threadId of [quiet, working, member, delegating, kept]) {
    yield* bots.createThread({ botId: bot.botId, threadId });
  }
  return bots;
});

const dumpPersonalTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'personal_%'
    ORDER BY name
  `;
  const dump: Record<string, ReadonlyArray<unknown>> = {};
  for (const { name } of tables) {
    // Sorted as JSON: some tables are WITHOUT ROWID, and insertion order is not state.
    const rows = yield* sql.unsafe(`SELECT * FROM "${name}"`);
    dump[name] = rows.map((row) => JSON.stringify(row)).toSorted();
  }
  return dump;
});

/**
 * Everything a run left behind, as JSON with its one random value (the
 * personal project's id, minted per database) replaced by a placeholder.
 */
const snapshot = (tables: Record<string, ReadonlyArray<unknown>>, extra: unknown): string => {
  const meta = (tables["personal_meta"] ?? []).map(
    (row) => JSON.parse(row as string) as { key: string; value: string },
  );
  const projectId = meta.find((row) => row.key === "personalProjectId")?.value ?? "none";
  return JSON.stringify({ tables, extra }, null, 1).replaceAll(projectId, "<project>");
};

const picked = [quiet, working, member, delegating];

describe("deletePersonalChats", () => {
  it.effect("leaves the same database state, dispatches and cancels as one delete per chat", () =>
    Effect.gen(function* () {
      const bulkDispatched: Array<OrchestrationCommand> = [];
      const bulk = yield* Effect.gen(function* () {
        const bots = yield* seed;
        const seeded = bulkDispatched.length;
        const { cancels, services } = makeServices(bots);
        const result = yield* deletePersonalChats(services, picked);
        const dispatched = bulkDispatched.slice(seeded);
        return { result, cancels, dispatched, tables: yield* dumpPersonalTables };
      }).pipe(Effect.provide(makeLayer(bulkDispatched)));

      const singleDispatched: Array<OrchestrationCommand> = [];
      const single = yield* Effect.gen(function* () {
        const bots = yield* seed;
        const seeded = singleDispatched.length;
        const { cancels, services } = makeServices(bots);
        for (const threadId of picked) {
          yield* Effect.exit(deletePersonalChat(services, threadId));
        }
        const dispatched = singleDispatched.slice(seeded);
        return { cancels, dispatched, tables: yield* dumpPersonalTables };
      }).pipe(Effect.provide(makeLayer(singleDispatched)));

      expect(snapshot(bulk.tables, { dispatched: bulk.dispatched, cancels: bulk.cancels })).toEqual(
        snapshot(single.tables, { dispatched: single.dispatched, cancels: single.cancels }),
      );
      // A working chat is not skipped, as a single delete does not skip it:
      // its task is cancelled first, then the chat goes.
      assert.deepEqual(bulk.cancels, ["task-running", "task-parked"]);
      assert.deepEqual(
        bulk.dispatched.map(
          (command) => `${command.type}:${"threadId" in command ? command.threadId : ""}`,
        ),
        [`thread.delete:${quiet}`, `thread.delete:${working}`, `thread.delete:${delegating}`],
      );
      assert.deepEqual(bulk.result.done, [quiet, working, delegating]);
      assert.deepEqual(
        bulk.result.failed.map((entry) => entry.threadId),
        [member],
      );
      expect(bulk.result.failed[0]?.message).toContain("Launch crew");
      // Only the refused member chat and the chat never picked stay linked.
      const links = (bulk.tables["personal_bot_threads"] ?? []).map(
        (row) => (JSON.parse(row as string) as { thread_id: string }).thread_id,
      );
      assert.deepEqual(links.toSorted(), [kept, member].toSorted());
    }),
  );

  it.effect("keeps going past a failed chat and reports a defect with the generic line", () =>
    Effect.gen(function* () {
      const deleted: Array<string> = [];
      const services = {
        bots: {
          deleteThread: ({ threadId }: { threadId: string }) =>
            threadId === working
              ? Effect.die(new Error("sqlite said no: /secret/path"))
              : Effect.sync(() => void deleted.push(threadId)),
        },
        tasks: {
          list: () => Effect.succeed({ tasks: [] }),
          cancel: () => Effect.void,
        },
        groups: { groupNameForMemberThread: () => Effect.succeed(Option.none()) },
      } as unknown as PersonalChatDeleteServices;

      // A repeated id is deleted once.
      const result = yield* deletePersonalChats(services, [quiet, working, quiet, kept]);

      assert.deepEqual(deleted, [quiet, kept]);
      assert.deepEqual(result.done, [quiet, kept]);
      assert.deepEqual(result.failed, [
        { threadId: working, message: "Couldn't delete this chat." },
      ]);
    }),
  );
});

describe("archivePersonalChats", () => {
  it.effect("archives and unarchives each chat, reporting one that is gone", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const bots = yield* seed;
      const gone = ThreadId.make("thread-gone");

      const archived = yield* archivePersonalChats(bots, [quiet, working, gone], true);
      assert.deepEqual(archived.done, [quiet, working]);
      assert.deepEqual(
        archived.failed.map((entry) => entry.threadId),
        [gone],
      );
      expect(archived.failed[0]?.message).toContain("was not found");
      const afterArchive = yield* bots.list();
      const archivedIds = afterArchive.threads
        .filter((thread) => thread.archivedAt !== null)
        .map((thread) => thread.threadId)
        .toSorted();
      assert.deepEqual(archivedIds, [quiet, working].toSorted());

      // Archiving the working chat stops its turn and the commands it started.
      const stops = dispatched.flatMap((command) =>
        command.type === "thread.session.stop" ? [command] : [],
      );
      assert.deepEqual(
        stops.map((command) => [command.threadId, command.terminateProcesses]),
        [[working, true]],
      );

      const restored = yield* archivePersonalChats(bots, [quiet, working], false);
      assert.deepEqual(restored.done, [quiet, working]);
      const afterRestore = yield* bots.list();
      expect(afterRestore.threads.every((thread) => thread.archivedAt === null)).toBe(true);
      // Unarchiving stops nothing.
      assert.equal(
        dispatched.filter((command) => command.type === "thread.session.stop").length,
        1,
      );
    }).pipe(Effect.provide(makeLayer(dispatched)));
  });

  it.effect("uses the server's own message for a refusal", () =>
    Effect.gen(function* () {
      const bots = {
        archiveThread: () => Effect.fail(new PersonalBotsError({ message: "Not today." })),
      } as unknown as PersonalBotService.PersonalBotService["Service"];
      const result = yield* archivePersonalChats(bots, [quiet], false);
      assert.deepEqual(result.failed, [{ threadId: quiet, message: "Not today." }]);
    }),
  );
});
