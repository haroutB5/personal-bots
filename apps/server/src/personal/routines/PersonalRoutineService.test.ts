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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
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
import { pushEventForTask } from "../push/PersonalPushService.ts";
import * as PersonalTaskRepository from "../tasks/PersonalTaskRepository.ts";
import * as PersonalTaskService from "../tasks/PersonalTaskService.ts";
import * as PersonalRoutineService from "./PersonalRoutineService.ts";

/**
 * Live chats the projection knows, by thread id, with their session status.
 * A thread missing here reads as deleted or archived, as the real
 * `getThreadShellById` returns nothing for either.
 */
type ShellSessions = Map<string, { readonly status: string; readonly activeTurnId?: string }>;

/** Orchestration is a recorder: routines only need tasks to be created. */
const makeLayer = (
  dbPath?: string,
  dispatched: Array<OrchestrationCommand> = [],
  shells: ShellSessions = new Map(),
) => {
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
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(
      Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getProjectShellById: () => Effect.succeed(Option.none()),
        getProjectShells: () => Effect.succeed([]),
        getThreadShellById: (threadId: ThreadId) =>
          Effect.sync(() => {
            const session = shells.get(threadId);
            return session === undefined
              ? Option.none()
              : Option.some({
                  id: threadId,
                  session: {
                    threadId,
                    status: session.status,
                    activeTurnId: session.activeTurnId ?? null,
                    lastError: null,
                    providerName: null,
                    updatedAt: "2026-09-25T00:00:00.000Z",
                  },
                });
          }),
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
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

const listedRoutineIds = Effect.gen(function* () {
  const routines = yield* PersonalRoutineService.PersonalRoutineService;
  return (yield* routines.list()).routines.map((routine) => routine.routineId);
});

it.effect("deletes a one-off after it fires but keeps its occurrence and task", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("one-off");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "One-off",
      prompt: "Do it once.",
      schedule: { kind: "once", at: "2026-09-14T11:30" },
    });

    yield* setNow("2026-09-14T10:30:10Z");
    yield* tickAndDrain;

    expect(yield* listedRoutineIds).not.toContain(routineId);
    expect(yield* occurrences(routineId)).toEqual([
      expect.objectContaining({ localOccurrence: "2026-09-14T11:30", status: "created" }),
    ]);
    expect((yield* routineTasks(routineId)).length).toBe(1);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps a recurring routine after it fires", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T06:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("recurring");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "Recurring",
      prompt: "Do it daily.",
      schedule: { kind: "daily", time: "09:00" },
    });

    yield* setNow("2026-09-14T08:00:10Z");
    yield* tickAndDrain;

    expect(yield* listedRoutineIds).toContain(routineId);
    expect(yield* nextDueIso(routineId)).toBe("2026-09-15T08:00:00.000Z");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("removes a pre-existing spent one-off on the startup scheduler pass", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("spent-before-upgrade");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "Spent",
      prompt: "Already ran.",
      schedule: { kind: "once", at: "2026-09-14T11:30" },
    });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_routine_occurrences
        (routine_id, local_occurrence, due_utc, task_id, status, error_message, created_at)
      VALUES (${routineId}, '2026-09-14T11:30', '2026-09-14T10:30:00.000Z', NULL, 'skipped', NULL,
        '2026-09-14T10:30:00.000Z')
    `;
    yield* sql`
      UPDATE personal_routines SET next_due_utc = NULL WHERE routine_id = ${routineId}
    `;

    yield* setNow("2026-09-14T12:00:00Z");
    yield* routines.tick;

    expect(yield* listedRoutineIds).not.toContain(routineId);
    expect(yield* occurrences(routineId)).toEqual([
      expect.objectContaining({ localOccurrence: "2026-09-14T11:30", status: "skipped" }),
    ]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("resume fails cleanly after an exhausted one-off is deleted", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("deleted-one-off");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "Deleted",
      prompt: "Run once.",
      schedule: { kind: "once", at: "2026-09-14T11:30" },
    });
    yield* setNow("2026-09-14T10:30:10Z");
    yield* tickAndDrain;

    const error = yield* Effect.flip(routines.resume({ routineId }));
    expect(error.message).toContain("was not found");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("resume deletes a paused one-off after its scheduled time has passed", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("paused-one-off");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "Paused once",
      prompt: "Run once.",
      schedule: { kind: "once", at: "2026-09-14T11:30" },
    });
    yield* routines.pause({ routineId });
    yield* setNow("2026-09-14T12:00:00Z");

    const error = yield* Effect.flip(routines.resume({ routineId }));
    expect(error.message).toContain("was not found");
    expect(yield* listedRoutineIds).not.toContain(routineId);
  }).pipe(Effect.provide(makeLayer())),
);

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

it.effect("create refuses a routine that submits both a schedule and an event name", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T12:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const both = yield* Effect.flip(
      routines.create({
        routineId: PersonalRoutineId.make("both"),
        botId: BOT,
        title: "x",
        prompt: "x",
        schedule: { kind: "daily", time: "09:00" },
        eventLabel: "PR merged",
      }),
    );
    expect(both.message).toContain("not both");
    // Refused whichever trigger the caller claims, so neither half is the one
    // that silently wins.
    const bothAsEvent = yield* Effect.flip(
      routines.create({
        routineId: PersonalRoutineId.make("both-event"),
        botId: BOT,
        title: "x",
        prompt: "x",
        trigger: "event",
        schedule: { kind: "daily", time: "09:00" },
        eventLabel: "PR merged",
      }),
    );
    expect(bothAsEvent.message).toContain("not both");
    expect(yield* listedRoutineIds).toEqual([]);

    // Either half on its own is still a valid create.
    const scheduled = yield* routines.create({
      routineId: PersonalRoutineId.make("schedule-only"),
      botId: BOT,
      title: "x",
      prompt: "x",
      schedule: { kind: "daily", time: "09:00" },
    });
    expect(scheduled.eventLabel).toBeNull();
    const event = yield* routines.create({
      routineId: PersonalRoutineId.make("event-only"),
      botId: BOT,
      title: "x",
      prompt: "x",
      trigger: "event",
      eventLabel: "PR merged",
    });
    expect(event.schedule).toBeNull();
    expect(event.eventLabel).toBe("PR merged");
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
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(makeLayer(), NodeServices.layer))),
);

const EVENT_ROUTINE = PersonalRoutineId.make("on-pr-merged");

const createEventRoutine = Effect.gen(function* () {
  const routines = yield* PersonalRoutineService.PersonalRoutineService;
  return yield* routines.create({
    routineId: EVENT_ROUTINE,
    botId: BOT,
    title: "PR watch",
    prompt: "Tell me what changed.",
    trigger: "event",
    eventLabel: "PR merged",
  });
});

it.effect("gives a new event routine an unguessable token and no schedule", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routine = yield* createEventRoutine;
    expect(routine.trigger).toBe("event");
    expect(routine.schedule).toBeNull();
    expect(routine.eventLabel).toBe("PR merged");
    expect(routine.nextDueAt).toBeNull();
    expect(routine.lastFiredAt).toBeNull();
    // 32 bytes, base64url, no padding.
    expect(routine.hookToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(routine.hookToken!, "base64url").length).toBe(32);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("never deletes an event routine on the no-future-runs sweep", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    yield* createEventRoutine;
    // The sweep is what deletes a spent one-off: an event routine has
    // next_due_utc NULL forever and must survive every pass.
    yield* setNow("2026-09-15T10:00:00Z");
    yield* tickAndDrain;
    yield* setNow("2026-10-30T10:00:00Z");
    yield* tickAndDrain;
    expect(yield* listedRoutineIds).toContain(EVENT_ROUTINE);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("fires once on a valid token and puts the payload in the prompt as data", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const created = yield* createEventRoutine;

    const fired = yield* routines.fireEvent({
      hookToken: created.hookToken!,
      contentType: "application/json",
      body: '{"number":7}',
    });
    expect(fired._tag).toBe("Fired");
    yield* tasks.drain;

    const started = yield* routineTasks(EVENT_ROUTINE);
    expect(started.length).toBe(1);
    expect(started[0]!.objective).toContain("Tell me what changed.");
    expect(started[0]!.objective).toContain("Triggered by event 'PR merged' with payload:");
    expect(started[0]!.objective).toContain("untrusted data");
    expect(started[0]!.objective).toContain('"number": 7');

    const after = yield* routines.get({ routineId: EVENT_ROUTINE });
    expect(after.lastFiredAt).not.toBeNull();
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("rate-limits a second delivery inside the window and never queues it", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const created = yield* createEventRoutine;
    const token = created.hookToken!;

    expect(
      (yield* routines.fireEvent({ hookToken: token, contentType: null, body: "1" }))._tag,
    ).toBe("Fired");
    yield* setNow("2026-09-14T10:00:20Z");
    const limited = yield* routines.fireEvent({ hookToken: token, contentType: null, body: "2" });
    expect(limited._tag).toBe("RateLimited");
    yield* tasks.drain;
    // The refused delivery did not land later: still exactly one run.
    expect((yield* routineTasks(EVENT_ROUTINE)).length).toBe(1);

    yield* setNow("2026-09-14T10:00:31Z");
    expect(
      (yield* routines.fireEvent({ hookToken: token, contentType: null, body: "3" }))._tag,
    ).toBe("Fired");
    yield* tasks.drain;
    expect((yield* routineTasks(EVENT_ROUTINE)).length).toBe(2);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("reports an unknown or paused token as not found, and fires nothing", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const created = yield* createEventRoutine;

    expect(
      (yield* routines.fireEvent({ hookToken: "z".repeat(43), contentType: null, body: "" }))._tag,
    ).toBe("NotFound");
    // A malformed segment never reaches the row scan either.
    expect(
      (yield* routines.fireEvent({ hookToken: "../state.sqlite", contentType: null, body: "" }))
        ._tag,
    ).toBe("NotFound");

    yield* routines.pause({ routineId: EVENT_ROUTINE });
    expect(
      (yield* routines.fireEvent({ hookToken: created.hookToken!, contentType: null, body: "" }))
        ._tag,
    ).toBe("NotFound");

    // Resuming an event routine restores it without inventing a schedule.
    const resumed = yield* routines.resume({ routineId: EVENT_ROUTINE });
    expect(resumed.enabled).toBe(true);
    expect(resumed.schedule).toBeNull();
    expect(
      (yield* routines.fireEvent({ hookToken: created.hookToken!, contentType: null, body: "" }))
        ._tag,
    ).toBe("Fired");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("regenerating the hook stops the old URL working", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const created = yield* createEventRoutine;
    const oldToken = created.hookToken!;

    const rotated = yield* routines.regenerateHook({ routineId: EVENT_ROUTINE });
    expect(rotated.hookToken).not.toBe(oldToken);
    expect(rotated.hookToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(
      (yield* routines.fireEvent({ hookToken: oldToken, contentType: null, body: "" }))._tag,
    ).toBe("NotFound");
    expect(
      (yield* routines.fireEvent({ hookToken: rotated.hookToken!, contentType: null, body: "" }))
        ._tag,
    ).toBe("Fired");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps an event routine's label editable without touching its schedule", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    yield* createEventRoutine;
    const updated = yield* routines.update({
      routineId: EVENT_ROUTINE,
      title: "PR watch v2",
      eventLabel: "PR closed",
    });
    expect(updated.title).toBe("PR watch v2");
    expect(updated.eventLabel).toBe("PR closed");
    expect(updated.schedule).toBeNull();
    expect(updated.nextDueAt).toBeNull();
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("moves an event routine to another time zone", () =>
  // The update handler validates the zone for every routine, but the event
  // branch used to write everything except the zone, so the call reported
  // success and changed nothing.
  Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    yield* createEventRoutine;
    const updated = yield* routines.update({
      routineId: EVENT_ROUTINE,
      timeZone: "America/New_York",
    });
    expect(updated.timeZone).toBe("America/New_York");
    // Still an event routine: moving the zone must not grow a schedule.
    expect(updated.schedule).toBeNull();
    expect(updated.nextDueAt).toBeNull();
  }).pipe(Effect.provide(makeLayer())),
);

// A relay routine posts text into the bot's chat as the bot's own message and
// starts no model turn; the run is a task that is already completed, so it
// shows in Tasks and notifies like any finished routine run.
const assistantPosts = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.flatMap((command) =>
    command.type === "thread.message.assistant.delta" ? [command] : [],
  );
const turnStarts = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.filter((command) => command.type === "thread.turn.start");

it.effect("relays an event payload's message verbatim into the bot's chat, with no turn", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    const created = yield* routines.create({
      routineId: EVENT_ROUTINE,
      botId: BOT,
      title: "Weekly upstream sync report",
      prompt: "A weekly upstream sync report arrived.",
      trigger: "event",
      eventLabel: "Upstream sync",
      delivery: "relay",
    });
    expect(created.delivery).toBe("relay");

    const message = "Synced 12 upstream commits.\n\nGates: all green.";
    const fired = yield* routines.fireEvent({
      hookToken: created.hookToken!,
      contentType: "application/json",
      body: encodeJson({ message }),
    });
    expect(fired._tag).toBe("Fired");
    yield* tasks.drain;

    const posts = assistantPosts(dispatched);
    expect(posts.map((post) => post.delta)).toEqual([message]);
    expect(turnStarts(dispatched)).toEqual([]);
    const completes = dispatched.filter(
      (command) => command.type === "thread.message.assistant.complete",
    );
    expect(completes.length).toBe(1);

    const [task] = yield* routineTasks(EVENT_ROUTINE);
    expect(task?.status).toBe("completed");
    expect(task?.source).toBe("routine");
    expect(task?.result?.summary).toBe(message);
    expect(task?.threadId).toBe(posts[0]!.threadId);
    // The same event the task stream turns into a routine notification.
    expect(pushEventForTask(task!)).toBe("routine_result");
  }).pipe(Effect.provide(makeLayer(undefined, dispatched)));
});

it.effect("fails a relay whose payload has no message, and posts nothing", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    yield* setNow("2026-09-14T10:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const created = yield* routines.create({
      routineId: EVENT_ROUTINE,
      botId: BOT,
      title: "Weekly upstream sync report",
      prompt: "A weekly upstream sync report arrived.",
      trigger: "event",
      eventLabel: "Upstream sync",
      delivery: "relay",
    });
    const fired = yield* routines.fireEvent({
      hookToken: created.hookToken!,
      contentType: "application/json",
      body: '{"text":"wrong field"}',
    });
    expect(fired._tag).toBe("Failed");
    expect(assistantPosts(dispatched)).toEqual([]);
    expect((yield* occurrences(EVENT_ROUTINE)).map((row) => row.status)).toEqual(["failed"]);
  }).pipe(Effect.provide(makeLayer(undefined, dispatched)));
});

it.effect("a scheduled relay posts its prompt, and an edit keeps the delivery", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  return Effect.gen(function* () {
    // 09:00 in London is 08:00 UTC in September.
    yield* setNow("2026-09-14T06:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("stand-up-reminder");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "Stand-up",
      prompt: "Stand-up in five minutes.",
      schedule: { kind: "daily", time: "09:00" },
      delivery: "relay",
    });
    const edited = yield* routines.update({ routineId, title: "Daily stand-up" });
    expect(edited.delivery).toBe("relay");

    yield* setNow("2026-09-14T07:30:00Z");
    yield* tickAndDrain;
    expect(assistantPosts(dispatched)).toEqual([]);
    yield* setNow("2026-09-14T08:00:10Z");
    yield* tickAndDrain;
    expect(assistantPosts(dispatched).map((post) => post.delta)).toEqual([
      "Stand-up in five minutes.",
    ]);
    expect(turnStarts(dispatched)).toEqual([]);
  }).pipe(Effect.provide(makeLayer(undefined, dispatched)));
});

// ── Preparers (the nightly Claude Code update run) ─────────────────────

const errorMessages = (routineId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly status: string; readonly errorMessage: string | null }>`
      SELECT status AS "status", error_message AS "errorMessage"
      FROM personal_routine_occurrences WHERE routine_id = ${routineId}
      ORDER BY local_occurrence ASC
    `;
  });

it.effect(
  "a preparer adds run data to the objective and records the start once the task exists",
  () =>
    Effect.gen(function* () {
      yield* setNow("2026-09-24T12:00:00Z");
      yield* seedBot;
      const routines = yield* PersonalRoutineService.PersonalRoutineService;
      const routineId = PersonalRoutineId.make("nightly");
      yield* routines.create({
        routineId,
        botId: BOT,
        title: "Nightly",
        prompt: "Steps.",
        schedule: { kind: "daily", time: "04:00" },
      });
      const seen: Array<{ localOccurrence: string; manual: boolean }> = [];
      const started: Array<string> = [];
      yield* routines.registerPreparer(routineId, (input) =>
        Effect.sync(() => {
          seen.push({ localOccurrence: input.localOccurrence, manual: input.manual });
          return {
            _tag: "Run" as const,
            objective: `${input.routine.prompt}\n\nRun data: ${input.localOccurrence}`,
            onStarted: (task) => Effect.sync(() => void started.push(task.taskId)),
          };
        }),
      );

      // 04:00 BST the next morning.
      yield* setNow("2026-09-25T03:00:05Z");
      yield* tickAndDrain;

      const [task] = yield* routineTasks("nightly");
      expect(task?.objective).toBe("Steps.\n\nRun data: 2026-09-25T04:00");
      expect(seen).toEqual([{ localOccurrence: "2026-09-25T04:00", manual: false }]);
      expect(started).toEqual([task!.taskId]);
      expect(yield* nextDueIso("nightly")).toBe("2026-09-26T03:00:00.000Z");

      // Run now tells the preparer it is manual.
      yield* routines.runNow({ routineId, requestId: "rehearsal" });
      expect(seen.at(-1)).toEqual({ localOccurrence: "manual:rehearsal", manual: true });
    }).pipe(Effect.provide(makeLayer())),
);

it.effect(
  "a preparer that finds nothing to do skips the slot quietly, with the reason on record",
  () =>
    Effect.gen(function* () {
      yield* setNow("2026-09-24T12:00:00Z");
      yield* seedBot;
      const routines = yield* PersonalRoutineService.PersonalRoutineService;
      const routineId = PersonalRoutineId.make("nightly");
      yield* routines.create({
        routineId,
        botId: BOT,
        title: "Nightly",
        prompt: "Steps.",
        schedule: { kind: "daily", time: "04:00" },
      });
      yield* routines.registerPreparer(routineId, () =>
        Effect.succeed({ _tag: "Skip" as const, reason: "nothing new" }),
      );

      yield* setNow("2026-09-25T03:00:05Z");
      yield* tickAndDrain;

      expect(yield* routineTasks("nightly")).toEqual([]);
      expect(yield* errorMessages("nightly")).toEqual([
        { status: "skipped", errorMessage: "nothing new" },
      ]);
      // The schedule still moves on to tomorrow.
      expect(yield* nextDueIso("nightly")).toBe("2026-09-26T03:00:00.000Z");
      // Run now says why instead of a generic failure.
      const manual = yield* Effect.flip(routines.runNow({ routineId, requestId: "r1" }));
      expect(manual.message).toBe("Nothing to run: nothing new.");
    }).pipe(Effect.provide(makeLayer())),
);

it.effect("a preparer that crashes fails the occurrence instead of starting a bare run", () =>
  Effect.gen(function* () {
    yield* setNow("2026-09-24T12:00:00Z");
    yield* seedBot;
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const routineId = PersonalRoutineId.make("nightly");
    yield* routines.create({
      routineId,
      botId: BOT,
      title: "Nightly",
      prompt: "Steps.",
      schedule: { kind: "daily", time: "04:00" },
    });
    yield* routines.registerPreparer(routineId, () => Effect.die(new Error("ledger is corrupt")));

    yield* setNow("2026-09-25T03:00:05Z");
    yield* tickAndDrain;

    expect(yield* routineTasks("nightly")).toEqual([]);
    const [row] = yield* errorMessages("nightly");
    expect(row?.status).toBe("failed");
    expect(row?.errorMessage).toContain("ledger is corrupt");
  }).pipe(Effect.provide(makeLayer())),
);

// --- Runs in the chat the routine was created from -------------------------

const CHAT = "chat-source" as ThreadId;
const OTHER_BOT = PersonalBotId.make("bot-other");

const seedChat = (threadId: ThreadId = CHAT, botId: PersonalBotId = BOT) =>
  Effect.gen(function* () {
    const bots = yield* PersonalBotService.PersonalBotService;
    yield* bots.createThread({ botId, threadId });
  });

const chatTurnStarts = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.flatMap((command) =>
    command.type === "thread.turn.start"
      ? [{ threadId: command.threadId as string, text: command.message.text }]
      : [],
  );

const createInChat = (
  routineId: string,
  extra: { readonly newChatEachRun?: boolean; readonly threadId?: ThreadId | null } = {},
) =>
  Effect.gen(function* () {
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    return yield* routines.create({
      routineId: PersonalRoutineId.make(routineId),
      botId: BOT,
      title: "Confirm release",
      prompt: "Check the release.",
      schedule: { kind: "once", at: "2026-09-25T16:20" },
      ...(extra.threadId === null ? {} : { threadId: extra.threadId ?? CHAT }),
      ...(extra.newChatEachRun === undefined ? {} : { newChatEachRun: extra.newChatEachRun }),
    });
  });

// 16:20 BST is 15:20Z.
const FIRE_AT = "2026-09-25T15:20:05Z";

it.effect("a routine made from a chat stores it and posts its run into that chat", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  const shells: ShellSessions = new Map([[CHAT, { status: "ready" }]]);
  return Effect.gen(function* () {
    yield* setNow("2026-09-25T15:00:00Z");
    yield* seedBot;
    yield* seedChat();
    const created = yield* createInChat("in-chat");
    expect(created.threadId).toBe(CHAT);
    expect(created.newChatEachRun).toBe(false);
    dispatched.length = 0;

    yield* setNow(FIRE_AT);
    yield* tickAndDrain;

    const [task] = yield* routineTasks("in-chat");
    expect(task?.threadId).toBe(CHAT);
    expect(task?.status).toBe("running");
    expect(chatTurnStarts(dispatched)).toEqual([
      { threadId: CHAT, text: expect.stringContaining("[Routine task]") },
    ]);
    // The existing chat is reused, never created again.
    expect(dispatched.some((command) => command.type === "thread.create")).toBe(false);
    const start = dispatched.find((command) => command.type === "thread.turn.start");
    // The task-turn marker the UI renders as "Routine: <title>".
    const record = start?.type === "thread.turn.start" ? start.message.context?.records[0] : null;
    expect(
      record !== null && record !== undefined && "payload" in record ? record.payload : null,
    ).toEqual(expect.objectContaining({ source: "routine", title: "Confirm release" }));
  }).pipe(Effect.provide(makeLayer(undefined, dispatched, shells)));
});

it.effect("a busy chat holds the run queued until it is idle, then runs it once", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  const shells: ShellSessions = new Map([[CHAT, { status: "running", activeTurnId: "user-turn" }]]);
  return Effect.gen(function* () {
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    yield* setNow("2026-09-25T15:00:00Z");
    yield* seedBot;
    yield* seedChat();
    yield* createInChat("busy");

    yield* setNow(FIRE_AT);
    yield* tickAndDrain;
    // Queued, not running: unfinished work for the idle-restart check.
    const [waiting] = yield* routineTasks("busy");
    expect(waiting?.status).toBe("queued");
    expect(waiting?.threadId).toBe(CHAT);
    expect(chatTurnStarts(dispatched)).toEqual([]);

    // Still busy on the next sweep: still waiting.
    yield* tasks.sweep;
    yield* tasks.drain;
    expect(chatTurnStarts(dispatched)).toEqual([]);

    shells.set(CHAT, { status: "ready" });
    yield* tasks.sweep;
    yield* tasks.drain;
    yield* tasks.sweep;
    yield* tasks.drain;
    expect(chatTurnStarts(dispatched).map((start) => start.threadId)).toEqual([CHAT]);
    expect((yield* routineTasks("busy"))[0]?.status).toBe("running");
  }).pipe(Effect.provide(makeLayer(undefined, dispatched, shells)));
});

it.effect(
  "falls back to a new chat when the source chat is archived, deleted or another bot's",
  () => {
    const dispatched: Array<OrchestrationCommand> = [];
    const archived = "chat-archived" as ThreadId;
    const deleted = "chat-deleted" as ThreadId;
    const shells: ShellSessions = new Map([
      [CHAT, { status: "ready" }],
      [archived, { status: "ready" }],
    ]);
    return Effect.gen(function* () {
      const bots = yield* PersonalBotService.PersonalBotService;
      const routines = yield* PersonalRoutineService.PersonalRoutineService;
      yield* setNow("2026-09-25T15:00:00Z");
      yield* seedBot;
      yield* bots.create({
        botId: OTHER_BOT,
        name: "Other",
        description: "",
        instructions: "",
        avatarShape: "roundedSquare",
        avatarColor: "#E5323B",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-test" },
      });
      yield* seedChat();
      yield* seedChat(archived);
      yield* seedChat(deleted);
      yield* bots.archiveThread({ threadId: archived, archived: true });
      yield* createInChat("archived", { threadId: archived });
      // Deleted: even if a link row lingers, the projection has no live thread.
      yield* createInChat("deleted", { threadId: deleted });
      yield* createInChat("handed-over");
      yield* routines.update({
        routineId: PersonalRoutineId.make("handed-over"),
        botId: OTHER_BOT,
      });

      yield* setNow(FIRE_AT);
      yield* tickAndDrain;

      for (const routineId of ["archived", "deleted", "handed-over"]) {
        const [task] = yield* routineTasks(routineId);
        // Null until claimed (a new chat is minted then); never one of these.
        expect([CHAT, archived, deleted]).not.toContain(task?.threadId);
      }
      expect(chatTurnStarts(dispatched).map((start) => start.threadId)).not.toContain(CHAT);
    }).pipe(Effect.provide(makeLayer(undefined, dispatched, shells)));
  },
);

it.effect("newChatEachRun opts out, and an edit can turn it back off", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  const shells: ShellSessions = new Map([[CHAT, { status: "ready" }]]);
  return Effect.gen(function* () {
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    yield* setNow("2026-09-25T15:00:00Z");
    yield* seedBot;
    yield* seedChat();
    const optedOut = yield* createInChat("opted-out", { newChatEachRun: true });
    expect(optedOut.threadId).toBe(CHAT);
    expect(optedOut.newChatEachRun).toBe(true);
    const flipped = yield* createInChat("flipped", { newChatEachRun: true });
    const edited = yield* routines.update({
      routineId: flipped.routineId,
      newChatEachRun: false,
    });
    expect(edited.newChatEachRun).toBe(false);
    // An edit that leaves the flag out keeps it.
    const renamed = yield* routines.update({ routineId: optedOut.routineId, title: "Renamed" });
    expect(renamed.newChatEachRun).toBe(true);

    yield* setNow(FIRE_AT);
    yield* tickAndDrain;

    expect((yield* routineTasks("opted-out"))[0]?.threadId).not.toBe(CHAT);
    expect((yield* routineTasks("flipped"))[0]?.threadId).toBe(CHAT);
  }).pipe(Effect.provide(makeLayer(undefined, dispatched, shells)));
});

it.effect("a routine with no source chat (legacy or Scheduled screen) opens a new chat", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  const shells: ShellSessions = new Map([[CHAT, { status: "ready" }]]);
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* setNow("2026-09-25T15:00:00Z");
    yield* seedBot;
    yield* seedChat();
    const created = yield* createInChat("no-chat", { threadId: null });
    expect(created.threadId).toBeNull();
    expect(created.newChatEachRun).toBe(false);
    const rows = yield* sql<{ readonly threadId: string | null; readonly flag: number }>`
      SELECT thread_id AS "threadId", new_chat_each_run AS "flag"
      FROM personal_routines WHERE routine_id = 'no-chat'
    `;
    expect(rows).toEqual([{ threadId: null, flag: 0 }]);
    dispatched.length = 0;

    yield* setNow(FIRE_AT);
    yield* tickAndDrain;

    const [task] = yield* routineTasks("no-chat");
    expect(task?.threadId).toBeTruthy();
    expect(task?.threadId).not.toBe(CHAT);
    expect(dispatched.some((command) => command.type === "thread.create")).toBe(true);
  }).pipe(Effect.provide(makeLayer(undefined, dispatched, shells)));
});

it.effect("a retried slot or Run now posts into the chat once, one run at a time", () => {
  const dispatched: Array<OrchestrationCommand> = [];
  const shells: ShellSessions = new Map([[CHAT, { status: "running", activeTurnId: "user-turn" }]]);
  return Effect.gen(function* () {
    const routines = yield* PersonalRoutineService.PersonalRoutineService;
    const tasks = yield* PersonalTaskService.PersonalTaskService;
    yield* setNow("2026-09-25T15:00:00Z");
    yield* seedBot;
    yield* seedChat();
    const routine = yield* routines.create({
      routineId: PersonalRoutineId.make("daily-in-chat"),
      botId: BOT,
      title: "Daily",
      prompt: "Daily check.",
      schedule: { kind: "daily", time: "16:20" },
      threadId: CHAT,
    });

    yield* setNow(FIRE_AT);
    yield* tickAndDrain;
    // Ticking again inside the slot, and the same Run now twice, add nothing.
    yield* tickAndDrain;
    yield* routines.runNow({ routineId: routine.routineId, requestId: "again" });
    yield* routines.runNow({ routineId: routine.routineId, requestId: "again" });
    const queued = yield* routineTasks("daily-in-chat");
    expect(queued.map((task) => [task.status, task.threadId])).toEqual([
      ["queued", CHAT],
      ["queued", CHAT],
    ]);

    // Idle: the two runs go one after the other, never together.
    shells.set(CHAT, { status: "ready" });
    yield* tasks.sweep;
    yield* tasks.drain;
    expect(chatTurnStarts(dispatched).length).toBe(1);
    yield* tasks.sweep;
    yield* tasks.drain;
    expect(chatTurnStarts(dispatched).length).toBe(1);
    expect(yield* occurrences("daily-in-chat")).toEqual([
      expect.objectContaining({ localOccurrence: "2026-09-25T16:20", status: "created" }),
      expect.objectContaining({ localOccurrence: "manual:again", status: "created" }),
    ]);
  }).pipe(Effect.provide(makeLayer(undefined, dispatched, shells)));
});
