import {
  PersonalBotId,
  PersonalProjectId,
  PersonalTaskId,
  ThreadId,
  type PersonalTask,
  type PersonalWorkEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as PersonalTaskRepository from "../tasks/PersonalTaskRepository.ts";
import * as PersonalWorkReads from "./PersonalWorkReads.ts";

const layer = PersonalTaskRepository.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const BOT = PersonalBotId.make("bot-developer");
const SINCE = "2026-11-14T10:00:00.000Z";
const NOW_MS = Date.UTC(2026, 10, 14, 12, 0, 0);

const at = (iso: string) => DateTime.makeUnsafe(iso);

const makeTask = (
  taskId: string,
  timestamps: { readonly createdAt: string; readonly completedAt: string | null },
  overrides: Partial<PersonalTask> = {},
): PersonalTask => {
  const completedAt = timestamps.completedAt === null ? null : at(timestamps.completedAt);
  return {
    taskId: PersonalTaskId.make(taskId),
    rootTaskId: PersonalTaskId.make(taskId),
    parentTaskId: null,
    botId: BOT,
    threadId: null,
    title: taskId,
    objective: "Objective.",
    acceptanceCriteria: "",
    expectedOutput: "",
    status: "completed",
    source: "delegation",
    idempotencyKey: `key-${taskId}`,
    depth: 1,
    maxDepth: 3,
    maxChildren: 5,
    result: null,
    errorCategory: null,
    errorMessage: null,
    availableAt: null,
    createdAt: at(timestamps.createdAt),
    updatedAt: completedAt ?? at(timestamps.createdAt),
    startedAt: at(timestamps.createdAt),
    completedAt,
    ...overrides,
  };
};

const insertAttempt = Effect.gen(function* () {
  const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
  return (input: {
    readonly taskId: string;
    readonly attempt: number;
    readonly startedAt: string;
    readonly endedAt: string;
    readonly errorCategory: string;
  }) =>
    repository.insertAttempt({
      taskId: PersonalTaskId.make(input.taskId),
      attempt: input.attempt,
      providerThreadId: ThreadId.make(`thread-${input.taskId}-${input.attempt}`),
      turnId: null,
      leaseOwner: "test",
      leaseExpiresAt: at(input.endedAt),
      heartbeatAt: at(input.endedAt),
      startedAt: at(input.startedAt),
      endedAt: at(input.endedAt),
      errorCategory: input.errorCategory,
      resumable: false,
    });
});

const insertProject = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly projectId: string;
  readonly name: string;
  readonly state: "open" | "done" | "dropped";
  readonly createdAt: string;
  readonly closedAt: string | null;
}) =>
  input.sql`
    INSERT INTO personal_projects (
      project_id, lead_bot_id, thread_id, name, steps_json, due_at, estimated_at,
      state, closed_at, created_at, updated_at
    )
    VALUES (
      ${input.projectId}, ${BOT}, NULL, ${input.name},
      '[{"label":"Build","state":"doing"}]', NULL, NULL,
      ${input.state}, ${input.closedAt}, ${input.createdAt}, ${input.createdAt}
    )
  `;

const read = PersonalWorkReads.since({ since: at(SINCE) });

const kinds = (events: ReadonlyArray<PersonalWorkEvent>) =>
  events.map((event) =>
    event.kind === "goalOpened" || event.kind === "goalClosed"
      ? `${event.kind}:${event.name}`
      : `${event.kind}:${event.task.title}`,
  );

describe("PersonalWorkReads.since", () => {
  it.effect(
    "a delegation completed one second before since is excluded and one after is included",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
        yield* repository.insertTask(
          makeTask("before", {
            createdAt: "2026-11-14T09:00:00.000Z",
            completedAt: "2026-11-14T09:59:59.000Z",
          }),
        );
        yield* repository.insertTask(
          makeTask("after", {
            createdAt: "2026-11-14T09:00:00.000Z",
            completedAt: "2026-11-14T10:00:01.000Z",
          }),
        );

        const result = yield* read;

        expect(kinds(result.events)).toEqual(["taskDone:after"]);
        expect(result.asOf).toEqual(DateTime.makeUnsafe("2026-11-14T12:00:00.000Z"));
      }).pipe(Effect.provide(layer)),
  );

  it.effect("a user-source completion is left out and a user-source failure is kept", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
      yield* repository.insertTask(
        makeTask(
          "user-done",
          { createdAt: "2026-11-14T09:00:00.000Z", completedAt: "2026-11-14T10:00:01.000Z" },
          { source: "user" },
        ),
      );
      yield* repository.insertTask(
        makeTask(
          "user-failed",
          { createdAt: "2026-11-14T09:00:00.000Z", completedAt: "2026-11-14T10:00:02.000Z" },
          { source: "user", status: "failed", errorCategory: "provider_error" },
        ),
      );

      const result = yield* read;

      expect(kinds(result.events)).toEqual(["taskFailed:user-failed"]);
      const failed = result.events[0];
      expect(failed?.kind === "taskFailed" ? failed.status : null).toBe("failed");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a rate-limit retry adds no event and an interrupted retry adds one restart", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
      const attempt = yield* insertAttempt;
      yield* repository.insertTask(
        makeTask(
          "limited",
          {
            createdAt: "2026-11-14T09:00:00.000Z",
            completedAt: null,
          },
          { status: "running" },
        ),
      );
      yield* repository.insertTask(
        makeTask(
          "stalled",
          {
            createdAt: "2026-11-14T09:00:00.000Z",
            completedAt: null,
          },
          { status: "running" },
        ),
      );
      yield* attempt({
        taskId: "limited",
        attempt: 1,
        startedAt: "2026-11-14T09:10:00.000Z",
        endedAt: "2026-11-14T09:20:00.000Z",
        errorCategory: "rate_limited",
      });
      yield* attempt({
        taskId: "limited",
        attempt: 2,
        startedAt: "2026-11-14T10:05:00.000Z",
        endedAt: "2026-11-14T10:15:00.000Z",
        errorCategory: "interrupted",
      });
      yield* attempt({
        taskId: "stalled",
        attempt: 1,
        startedAt: "2026-11-14T09:10:00.000Z",
        endedAt: "2026-11-14T09:20:00.000Z",
        errorCategory: "interrupted",
      });
      yield* attempt({
        taskId: "stalled",
        attempt: 2,
        startedAt: "2026-11-14T10:05:00.000Z",
        endedAt: "2026-11-14T10:15:00.000Z",
        errorCategory: "completed",
      });

      const result = yield* read;

      expect(kinds(result.events)).toEqual(["taskRestarted:stalled"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("goals opened and closed since appear, older ones do not", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const sql = yield* SqlClient.SqlClient;
      yield* insertProject({
        sql,
        projectId: PersonalProjectId.make("goal-new"),
        name: "hbots 1.67.23",
        state: "done",
        createdAt: "2026-11-14T09:59:59.000Z",
        closedAt: "2026-11-14T10:30:00.000Z",
      });
      yield* insertProject({
        sql,
        projectId: PersonalProjectId.make("goal-old"),
        name: "Old goal",
        state: "open",
        createdAt: "2026-11-14T09:59:59.000Z",
        closedAt: null,
      });
      yield* insertProject({
        sql,
        projectId: PersonalProjectId.make("goal-opened"),
        name: "Projects APK",
        state: "open",
        createdAt: "2026-11-14T10:00:01.000Z",
        closedAt: null,
      });

      const result = yield* read;

      expect(kinds(result.events)).toEqual(["goalClosed:hbots 1.67.23", "goalOpened:Projects APK"]);
      const closed = result.events[0];
      expect(closed?.kind === "goalClosed" ? closed.outcome : null).toBe("done");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the 60 newest events and counts the rest as omitted", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
      for (let index = 0; index < 65; index += 1) {
        const label = String(index).padStart(2, "0");
        yield* repository.insertTask(
          makeTask(`task-${label}`, {
            createdAt: "2026-11-14T09:00:00.000Z",
            completedAt: new Date(Date.UTC(2026, 10, 14, 10, 1 + index, 0)).toISOString(),
          }),
        );
      }

      const result = yield* read;

      expect(result.events).toHaveLength(60);
      expect(result.omitted).toBe(5);
      const newest = result.events[0];
      const oldest = result.events.at(-1);
      expect(newest?.kind === "taskDone" ? newest.task.title : null).toBe("task-64");
      expect(oldest?.kind === "taskDone" ? oldest.task.title : null).toBe("task-05");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clamps a very old since to the last seven days", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const repository = yield* PersonalTaskRepository.PersonalTaskRepository;
      yield* repository.insertTask(
        makeTask("eight-days", {
          createdAt: "2026-11-01T09:00:00.000Z",
          completedAt: "2026-11-06T10:00:00.000Z",
        }),
      );

      const result = yield* PersonalWorkReads.since({
        since: at("2026-10-01T00:00:00.000Z"),
      });

      expect(result.events).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
