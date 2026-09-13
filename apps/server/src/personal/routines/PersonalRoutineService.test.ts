import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PersonalBotId,
  PersonalRoutineId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";
import * as PersonalBotRepository from "../PersonalBotRepository.ts";
import * as PersonalBotService from "../PersonalBotService.ts";
import * as PersonalTaskRepository from "../tasks/PersonalTaskRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalRoutineService from "./PersonalRoutineService.ts";

/** Orchestration is a recorder: routines only need tasks to be created. */
const makeLayer = (dbPath?: string) => {
  const dispatched: Array<OrchestrationCommand> = [];
  return PersonalRoutineService.layer.pipe(
    Layer.provideMerge(PersonalTaskService.layer),
    Layer.provideMerge(PersonalTaskRepository.layer),
    Layer.provideMerge(PersonalBotService.layer),
    Layer.provideMerge(PersonalBotRepository.layer),
    Layer.provideMerge(
      dbPath === undefined ? SqlitePersistenceMemory : makeSqlitePersistenceLive(dbPath),
    ),
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        subscribeDomainEvents: Effect.succeed(Stream.never),
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
        getThreadShellById: (_threadId: ThreadId) => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectionThreadMessageRepository, {
        listByThreadId: () => Effect.succeed([]),
        getByMessageId: () => Effect.succeed(Option.none()),
        getLatestAssistantMessageForTurn: () => Effect.succeed(Option.none()),
        getLatestAssistantMessageAfter: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionThreadMessageRepositoryShape),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-personal-routines-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

const BOT = PersonalBotId.make("bot-planner");

const seedBot = Effect.gen(function* () {
  const bots = yield* PersonalBotService.PersonalBotService;
  yield* bots.create({
    botId: BOT,
    name: "Planner",
    description: "",
    instructions: "",
    avatarShape: "roundedSquare",
    avatarColor: "#E5323B",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
  });
});

const setNow = (value: string) => TestClock.setTime(Date.parse(value));

const occurrences = (routineId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly localOccurrence: string;
      readonly status: string;
      readonly taskId: string | null;
    }>`
      SELECT local_occurrence AS "localOccurrence", status AS "status", task_id AS "taskId"
      FROM personal_routine_occurrences WHERE routine_id = ${routineId}
      ORDER BY local_occurrence ASC
    `;
  });

const routineTasks = (routineId: string) =>
  Effect.gen(function* () {
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const all = (yield* tasks.list({})).tasks;
    return all.filter((task) => task.idempotencyKey.startsWith(`routine:${routineId}:`));
  });

const tickAndDrain = Effect.gen(function* () {
  const routines = yield* PersonalRoutineService.PersonalRoutineService;
  const tasks = yield* PersonalTaskService.PersonalTaskService;
  yield* routines.tick;
  yield* tasks.drain;
});

const nextDueIso = (routineId: string) =>
  Effect.gen(function* () {
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routine = yield* routines.get({ routineId: PersonalRoutineId.make(routineId) });
    return routine.nextDueAt === null ? null : DateTime.formatIso(routine.nextDueAt);
  });

it.effect("spring-forward: a 01:30 routine fires once, at 02:00 BST", () =>
  Effect.gen(function* () {
    yield* setNow("2026-03-28T12:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routine = yield* routines.create({
      routineId: PersonalRoutineId.make("spring"),
      botId: BOT,
      title: "Night job",
      prompt: "Summarise the day.",
      schedule: { kind: "daily", time: "01:30" },
    });
    expect(routine.timeZone).toBe("Europe/London");
    expect(yield* nextDueIso("spring")).toBe("2026-03-29T01:00:00.000Z");

    yield* setNow("2026-03-29T00:59:00Z");
    yield* tickAndDrain;
    expect(yield* occurrences("spring")).toEqual([]);

    yield* setNow("2026-03-29T01:00:20Z");
    yield* tickAndDrain;
    yield* tickAndDrain;
    const fired = yield* occurrences("spring");
    expect(fired.map((row) => [row.localOccurrence, row.status])).toEqual([
      ["2026-03-29T01:30", "created"],
    ]);
    const created = yield* routineTasks("spring");
    expect(created.map((task) => [task.idempotencyKey, task.source])).toEqual([
      ["routine:spring:2026-03-29T01:30", "routine"],
    ]);
    expect(yield* nextDueIso("spring")).toBe("2026-03-30T00:30:00.000Z");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("fall-back: the repeated 01:30 hour does not fire a second time", () =>
  Effect.gen(function* () {
    yield* setNow("2026-10-24T12:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    yield* routines.create({
      routineId: PersonalRoutineId.make("autumn"),
      botId: BOT,
      title: "Night job",
      prompt: "Summarise the day.",
      schedule: { kind: "daily", time: "01:30" },
    });
    expect(yield* nextDueIso("autumn")).toBe("2026-10-25T00:30:00.000Z");

    yield* setNow("2026-10-25T00:30:10Z");
    yield* tickAndDrain;
    // 01:30 GMT: the same local wall time, one hour later.
    yield* setNow("2026-10-25T01:30:10Z");
    yield* tickAndDrain;

    expect((yield* occurrences("autumn")).map((row) => row.localOccurrence)).toEqual([
      "2026-10-25T01:30",
    ]);
    expect((yield* routineTasks("autumn")).length).toBe(1);
    expect(yield* nextDueIso("autumn")).toBe("2026-10-26T01:30:00.000Z");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("after a 10h sleep, coalesce runs the latest missed slot once and skip runs none", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T08:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    for (const [routineId, missedPolicy] of [
      ["hourly-coalesce", "coalesce"],
      ["hourly-skip", "skip"],
    ] as const) {
      yield* routines.create({
        routineId: PersonalRoutineId.make(routineId),
        botId: BOT,
        title: routineId,
        prompt: "Check the inbox.",
        schedule: { kind: "interval", everyHours: 1 },
        missedPolicy,
      });
    }
    expect(yield* nextDueIso("hourly-coalesce")).toBe("2026-09-14T09:00:00.000Z");

    // The laptop sleeps through ten slots and wakes 15 minutes after the last.
    yield* setNow("2026-09-14T18:15:00Z");
    yield* tickAndDrain;
    yield* tickAndDrain;

    expect(yield* occurrences("hourly-coalesce")).toEqual([
      expect.objectContaining({ localOccurrence: "2026-09-14T19:00+01:00", status: "created" }),
    ]);
    expect((yield* routineTasks("hourly-coalesce")).length).toBe(1);

    expect(yield* occurrences("hourly-skip")).toEqual([
      expect.objectContaining({ localOccurrence: "2026-09-14T19:00+01:00", status: "skipped" }),
    ]);
    expect((yield* routineTasks("hourly-skip")).length).toBe(0);

    for (const routineId of ["hourly-coalesce", "hourly-skip"]) {
      expect(yield* nextDueIso(routineId)).toBe("2026-09-14T19:00:00.000Z");
    }

    // An on-time slot runs whatever the policy.
    yield* setNow("2026-09-14T19:00:30Z");
    yield* tickAndDrain;
    expect((yield* routineTasks("hourly-skip")).length).toBe(1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("a restart before the routine advanced does not duplicate the occurrence", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-routines-db-" });
    const dbPath = path.join(directory, "state.sqlite");

    yield* Effect.gen(function* () {
      yield* setNow("2026-09-14T06:00:00Z");
      yield* seedBot;
      const routines = yield* PersonalRoutineService.PersonalRoutineService;
      yield* routines.create({
        routineId: PersonalRoutineId.make("morning"),
        botId: BOT,
        title: "Morning briefing",
        prompt: "Brief me.",
        schedule: { kind: "daily", time: "09:00" },
      });
      yield* setNow("2026-09-14T08:00:05Z");
      yield* tickAndDrain;
      expect((yield* occurrences("morning")).length).toBe(1);
      // Simulate a crash between firing and advancing the routine.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        UPDATE personal_routines SET next_due_utc = '2026-09-14T08:00:00.000Z'
        WHERE routine_id = 'morning'
      `;
    }).pipe(Effect.provide(makeLayer(dbPath)));

    // A fresh process over the same database catches up again.
    yield* Effect.gen(function* () {
      yield* setNow("2026-09-14T08:03:00Z");
      yield* tickAndDrain;
      const rows = yield* occurrences("morning");
      expect(rows.map((row) => row.localOccurrence)).toEqual(["2026-09-14T09:00"]);
      expect(rows[0]?.taskId).not.toBeNull();
      expect((yield* routineTasks("morning")).length).toBe(1);
      expect(yield* nextDueIso("morning")).toBe("2026-09-15T08:00:00.000Z");
    }).pipe(Effect.provide(makeLayer(dbPath)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("Run now creates its own occurrence key and dedupes on the request id", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T06:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("adhoc");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "Weekly review",
      prompt: "Review the week.",
      schedule: { kind: "weekly", days: [5], time: "17:00" },
    });
    const before = yield* nextDueIso("adhoc");

    const first = yield* routines.runNow({ routineId, requestId: "req-1" });
    const again = yield* routines.runNow({ routineId, requestId: "req-1" });
    const second = yield* routines.runNow({ routineId, requestId: "req-2" });

    expect(again.task.taskId).toBe(first.task.taskId);
    expect(second.task.taskId).not.toBe(first.task.taskId);
    expect((yield* occurrences("adhoc")).map((row) => row.localOccurrence)).toEqual([
      "manual:req-1",
      "manual:req-2",
    ]);
    expect(first.task.idempotencyKey).toBe("routine:adhoc:manual:req-1");
    // A manual run never consumes or moves the scheduled slot.
    expect(yield* nextDueIso("adhoc")).toBe(before);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("pause stops firing and resume skips what was due while paused", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T06:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("paused");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "Paused",
      prompt: "Do it.",
      schedule: { kind: "daily", time: "09:00" },
    });
    yield* routines.pause({ routineId });
    yield* setNow("2026-09-14T08:00:10Z");
    yield* tickAndDrain;
    expect(yield* occurrences("paused")).toEqual([]);

    yield* setNow("2026-09-14T12:00:00Z");
    const resumed = yield* routines.resume({ routineId });
    expect(resumed.enabled).toBe(true);
    expect(yield* nextDueIso("paused")).toBe("2026-09-15T08:00:00.000Z");
    yield* tickAndDrain;
    expect(yield* occurrences("paused")).toEqual([]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("create rejects an unknown time zone and a one-off in the past", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T12:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const badZone = yield* Effect.flip(
      routines.create({
        routineId: PersonalRoutineId.make("bad-zone"),
        botId: BOT,
        title: "x",
        prompt: "x",
        schedule: { kind: "daily", time: "09:00" },
        timeZone: "Mars/Olympus",
      }),
    );
    expect(badZone.message).toContain("time zone");
    const past = yield* Effect.flip(
      routines.create({
        routineId: PersonalRoutineId.make("past"),
        botId: BOT,
        title: "x",
        prompt: "x",
        schedule: { kind: "once", at: "2026-09-14T09:00" },
      }),
    );
    expect(past.message).toContain("already passed");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("prunes ancient occurrence rows on tick and lists only the recent window", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T06:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    yield* routines.create({
      routineId: PersonalRoutineId.make("prune"),
      botId: BOT,
      title: "Prune me",
      prompt: "Go.",
      schedule: { kind: "daily", time: "09:00" },
    });
    const sql = yield* SqlClient.SqlClient;
    // 200 days old: beyond retention, must be deleted by the next tick.
    yield* sql`
      INSERT INTO personal_routine_occurrences
        (routine_id, local_occurrence, due_utc, task_id, status, error_message, created_at)
      VALUES ('prune', '2026-02-26T09:00', '2026-02-26T09:00:00.000Z', NULL, 'skipped', NULL,
        '2026-02-26T09:00:00.000Z')
    `;
    // 60 days old: kept in the table, but outside the 30-day list window.
    yield* sql`
      INSERT INTO personal_routine_occurrences
        (routine_id, local_occurrence, due_utc, task_id, status, error_message, created_at)
      VALUES ('prune', '2026-07-16T09:00', '2026-07-16T09:00:00.000Z', NULL, 'skipped', NULL,
        '2026-07-16T09:00:00.000Z')
    `;
    yield* setNow("2026-09-14T08:00:05Z");
    yield* tickAndDrain;
    const rows = yield* occurrences("prune");
    expect(rows.map((row) => row.localOccurrence).toSorted()).toEqual([
      "2026-07-16T09:00",
      "2026-09-14T09:00",
    ]);
    const listed = yield* routines.list();
    expect(
      listed.occurrences
        .filter((row) => row.routineId === "prune")
        .map((row) => row.localOccurrence),
    ).toEqual(["2026-09-14T09:00"]);
  }).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.provide(NodeServices.layer)),
);
