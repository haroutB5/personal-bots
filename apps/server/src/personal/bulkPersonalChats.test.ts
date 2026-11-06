import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  PersonalBotId,
  PersonalBotsError,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { PersonalProviders } from "./engine/PersonalProviders.ts";
import { archivePersonalChats, deletePersonalChats } from "./bulkPersonalChats.ts";
import { deletePersonalChat, type PersonalChatDeleteServices } from "./deletePersonalChat.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import * as PersonalBotService from "./PersonalBotService.ts";
import {
  makePersonalEngineHarness,
  personalEngineTestLayer,
} from "./test/personalEngineTestLayer.ts";
import { personalTestDatabase } from "./test/personalReadsTestLayer.ts";

const quiet = ThreadId.make("thread-quiet");
const working = ThreadId.make("thread-working");
const member = ThreadId.make("thread-group-member");
const delegating = ThreadId.make("thread-delegating");
const kept = ThreadId.make("thread-kept");

/**
 * The real bot service over an in-memory database and the v2 thread engine
 * fake: it applies thread commands to the v2 projections and records them.
 */
const makeLayer = () => {
  const harness = makePersonalEngineHarness();
  const layer = PersonalBotService.layerRequiringEngine.pipe(
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(personalEngineTestLayer(harness)),
    Layer.provideMerge(
      Layer.mock(PersonalProviders)({
        listProviders: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(personalTestDatabase),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-bulk-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return { harness, layer };
};

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

/** Marks a created chat's latest run as running, so a session is in flight. */
const markThreadRunning = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
          completed_at, payload_json)
      VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', NULL, 'running',
        '2026-11-06T00:00:00.000Z', NULL, '{}')
    `;
  });

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

const commandLabel = (command: OrchestrationV2ServerCommand) =>
  command.type === "thread.delete" ? `${command.type}:${command.threadId}` : command.type;

const picked = [quiet, working, member, delegating];

describe("deletePersonalChats", () => {
  it.effect("leaves the same database state, dispatches and cancels as one delete per chat", () =>
    Effect.gen(function* () {
      const bulkRun = makeLayer();
      const bulk = yield* Effect.gen(function* () {
        const bots = yield* seed;
        const seeded = bulkRun.harness.dispatched.length;
        const { cancels, services } = makeServices(bots);
        const result = yield* deletePersonalChats(services, picked);
        const dispatched = bulkRun.harness.dispatched.slice(seeded);
        return { result, cancels, dispatched, tables: yield* dumpPersonalTables };
      }).pipe(Effect.provide(bulkRun.layer));

      const singleRun = makeLayer();
      const single = yield* Effect.gen(function* () {
        const bots = yield* seed;
        const seeded = singleRun.harness.dispatched.length;
        const { cancels, services } = makeServices(bots);
        for (const threadId of picked) {
          yield* Effect.exit(deletePersonalChat(services, threadId));
        }
        const dispatched = singleRun.harness.dispatched.slice(seeded);
        return { cancels, dispatched, tables: yield* dumpPersonalTables };
      }).pipe(Effect.provide(singleRun.layer));

      expect(snapshot(bulk.tables, { dispatched: bulk.dispatched, cancels: bulk.cancels })).toEqual(
        snapshot(single.tables, { dispatched: single.dispatched, cancels: single.cancels }),
      );
      // A working chat is not skipped, as a single delete does not skip it:
      // its task is cancelled first, then the chat goes.
      assert.deepEqual(bulk.cancels, ["task-running", "task-parked"]);
      assert.deepEqual(bulk.dispatched.map(commandLabel), [
        `thread.delete:${quiet}`,
        `thread.delete:${working}`,
        `thread.delete:${delegating}`,
      ]);
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
    const run = makeLayer();
    return Effect.gen(function* () {
      const bots = yield* seed;
      yield* markThreadRunning(working);
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

      // Archiving the working chat stops its turn.
      const stops = run.harness.dispatched.flatMap((command) =>
        command.type === "thread.stop" ? [command] : [],
      );
      assert.deepEqual(
        stops.map((command) => command.threadId),
        [working],
      );

      const restored = yield* archivePersonalChats(bots, [quiet, working], false);
      assert.deepEqual(restored.done, [quiet, working]);
      const afterRestore = yield* bots.list();
      expect(afterRestore.threads.every((thread) => thread.archivedAt === null)).toBe(true);
      // Unarchiving stops nothing.
      assert.equal(
        run.harness.dispatched.filter((command) => command.type === "thread.stop").length,
        1,
      );
    }).pipe(Effect.provide(run.layer));
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
