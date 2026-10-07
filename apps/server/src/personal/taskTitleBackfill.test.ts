import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PersonalBotRepository from "./PersonalBotRepository.ts";
import {
  renameTaskTitleBackfill,
  runTaskTitleBackfill,
  selectTaskTitleBackfill,
  TASK_TITLE_BACKFILL_META_KEY,
} from "./taskTitleBackfill.ts";

const makeLayer = () =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    PersonalBotRepository.layer,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-title-backfill-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const projectId = ProjectId.make("project-backfill");
const T = {
  delegation: ThreadId.make("thread-delegation"),
  routine: ThreadId.make("thread-routine"),
  mixed: ThreadId.make("thread-mixed"),
  user: ThreadId.make("thread-user"),
  group: ThreadId.make("thread-group"),
  member: ThreadId.make("thread-group-member"),
  deleted: ThreadId.make("thread-deleted"),
  titled: ThreadId.make("thread-titled"),
  manual: ThreadId.make("thread-manual"),
} as const;

let commandCount = 0;
const nextCommandId = (tag: string) => CommandId.make(`test:${tag}:${++commandCount}`);

const createThread = (threadId: ThreadId, minute: number, title = "New chat") =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.create",
      commandId: nextCommandId("thread-create"),
      threadId,
      projectId,
      title,
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`,
    });
  });

const manualRename = (threadId: ThreadId, title: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.meta.update",
      commandId: nextCommandId("rename"),
      threadId,
      title,
    });
  });

const insertTask = (input: {
  taskId: string;
  title: string;
  source: "delegation" | "routine";
  createdAt: string;
  threadId: ThreadId | null;
  attemptThreadId?: ThreadId;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO personal_tasks (
        task_id, root_task_id, bot_id, thread_id, title, objective, status, source,
        idempotency_key, depth, max_depth, max_children, created_at, updated_at
      ) VALUES (
        ${input.taskId}, ${input.taskId}, 'bot-a', ${input.threadId}, ${input.title}, 'x',
        'completed', ${input.source}, ${input.taskId}, 0, 3, 5, ${input.createdAt}, ${input.createdAt}
      )
    `;
    if (input.attemptThreadId !== undefined) {
      yield* sql`
        INSERT INTO personal_task_attempts (
          task_id, attempt, provider_thread_id, lease_owner, lease_expires_at, heartbeat_at, started_at
        ) VALUES (
          ${input.taskId}, 1, ${input.attemptThreadId}, 'test', ${input.createdAt},
          ${input.createdAt}, ${input.createdAt}
        )
      `;
    }
  });

/**
 * Every kind of chat the rule has to judge. Only the delegation, routine and
 * mixed chats qualify.
 */
const seed = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const sql = yield* SqlClient.SqlClient;
  yield* engine.dispatch({
    type: "project.create",
    commandId: nextCommandId("project-create"),
    projectId,
    title: "Bots",
    workspaceRoot: "/tmp/task-title-backfill",
    createdAt: "2026-09-01T09:00:00.000Z",
  });
  yield* createThread(T.delegation, 1);
  yield* createThread(T.routine, 2);
  yield* createThread(T.mixed, 3);
  yield* createThread(T.user, 4);
  yield* createThread(T.group, 5);
  yield* createThread(T.member, 6);
  yield* createThread(T.deleted, 7);
  yield* createThread(T.titled, 8, "Already named");
  yield* createThread(T.manual, 9);

  yield* insertTask({
    taskId: "task-delegation",
    title: "Fix   the\nlogin bug",
    source: "delegation",
    createdAt: "2026-09-01T10:01:00.000Z",
    threadId: T.delegation,
  });
  // A routine run whose chat is only known through its attempt.
  yield* insertTask({
    taskId: "task-routine",
    title: "Morning briefing",
    source: "routine",
    createdAt: "2026-09-01T10:02:00.000Z",
    threadId: null,
    attemptThreadId: T.routine,
  });
  // Mixed: the routine created the chat, a later delegation ran in it.
  yield* insertTask({
    taskId: "task-mixed-routine",
    title: "Nightly check",
    source: "routine",
    createdAt: "2026-09-01T10:03:00.000Z",
    threadId: T.mixed,
  });
  yield* insertTask({
    taskId: "task-mixed-delegation",
    title: "Follow-up from CTO",
    source: "delegation",
    createdAt: "2026-09-01T10:30:00.000Z",
    threadId: null,
    attemptThreadId: T.mixed,
  });
  for (const [key, threadId] of [
    ["group", T.group],
    ["member", T.member],
    ["deleted", T.deleted],
    ["titled", T.titled],
    ["manual", T.manual],
  ] as const) {
    yield* insertTask({
      taskId: `task-${key}`,
      title: `Task for ${key}`,
      source: "delegation",
      createdAt: "2026-09-01T10:40:00.000Z",
      threadId,
    });
  }
  yield* sql`
    INSERT INTO personal_groups (group_id, name, thread_id, max_bot_turns, created_at, updated_at)
    VALUES ('group-1', 'Crew', ${T.group}, 10, '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO personal_group_members (group_id, bot_id, thread_id, joined_at)
    VALUES ('group-1', 'bot-a', ${T.member}, '2026-09-01T10:00:00.000Z')
  `;
  yield* engine.dispatch({
    type: "thread.delete",
    commandId: nextCommandId("delete"),
    threadId: T.deleted,
  });
  // A manual rename that happens to read "New chat" still wins.
  yield* manualRename(T.manual, "New chat");
});

const threadShell = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    return Option.getOrThrow(yield* snapshots.getThreadShellById(threadId));
  });

/** Every live thread as the lists sort them: newest `updatedAt` first. */
const listOrder = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const snapshot = yield* snapshots.getShellSnapshot();
  return snapshot.threads
    .map((thread) => ({ id: thread.id, updatedAt: thread.updatedAt }))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
});

const getMarker = Effect.gen(function* () {
  const repo = yield* PersonalBotRepository.PersonalBotRepository;
  return yield* repo.getMeta({ key: TASK_TITLE_BACKFILL_META_KEY });
});

describe("task title backfill", () => {
  it.effect("selects delegation, routine and mixed chats; mixed takes the routine's title", () =>
    Effect.gen(function* () {
      yield* seed;
      const candidates = yield* selectTaskTitleBackfill();
      assert.deepEqual(
        candidates.map(({ threadId, title, taskId }) => ({ threadId, title, taskId })),
        [
          { threadId: T.delegation, title: "Fix the login bug", taskId: "task-delegation" },
          { threadId: T.routine, title: "Morning briefing", taskId: "task-routine" },
          { threadId: T.mixed, title: "Nightly check", taskId: "task-mixed-routine" },
        ],
      );
      // User, group, member, deleted, already titled and manual chats are out.
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("skips a chat renamed between selection and dispatch", () =>
    Effect.gen(function* () {
      yield* seed;
      const engine = yield* OrchestrationEngineService;
      const candidates = yield* selectTaskTitleBackfill();
      // After selection: the user renames one chat, the title generator names another.
      yield* manualRename(T.delegation, "My own name");
      yield* engine.dispatch({
        type: "thread.title.generate.complete",
        commandId: nextCommandId("generated"),
        threadId: T.routine,
        title: "Generated elsewhere",
        expectedTitle: "New chat",
        expectedVersion: null,
        needsRefinement: false,
      });

      const result = yield* renameTaskTitleBackfill(candidates);

      assert.deepEqual(result, {
        renamed: 1,
        skipped: { gone: 0, manual: 1, changed: 1 },
        failed: 0,
      });
      assert.equal((yield* threadShell(T.delegation)).title, "My own name");
      assert.equal((yield* threadShell(T.routine)).title, "Generated elsewhere");
      assert.equal((yield* threadShell(T.mixed)).title, "Nightly check");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("gives a title a number when another open chat of the same bot already has it", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      // Two chats of one bot whose tasks share a title.
      yield* sql`UPDATE personal_tasks SET title = 'Fix the login bug' WHERE task_id = 'task-routine'`;
      yield* sql`
        INSERT OR IGNORE INTO personal_bots (
          bot_id, name, avatar_shape, avatar_color, model_selection_json, created_at, updated_at
        ) VALUES (
          'bot-a', 'Bot A', 'blob', '#1A73E8', '{}',
          '2026-09-01T09:00:00.000Z', '2026-09-01T09:00:00.000Z'
        )
      `;
      for (const threadId of [T.delegation, T.routine]) {
        yield* sql`
          INSERT INTO personal_bot_threads (thread_id, bot_id, created_at)
          VALUES (${threadId}, 'bot-a', '2026-09-01T10:00:00.000Z')
        `;
      }

      const result = yield* runTaskTitleBackfill();

      assert.deepEqual(result, {
        renamed: 3,
        skipped: { gone: 0, manual: 0, changed: 0 },
        failed: 0,
      });
      assert.equal((yield* threadShell(T.delegation)).title, "Fix the login bug");
      assert.equal((yield* threadShell(T.routine)).title, "Fix the login bug 2");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("renames through the engine without moving any chat or touching updatedAt", () =>
    Effect.gen(function* () {
      yield* seed;
      const before = yield* listOrder;

      const result = yield* runTaskTitleBackfill();

      assert.deepEqual(result, {
        renamed: 3,
        skipped: { gone: 0, manual: 0, changed: 0 },
        failed: 0,
      });
      assert.deepEqual(yield* listOrder, before);
      const renamed = yield* threadShell(T.delegation);
      assert.equal(renamed.title, "Fix the login bug");
      assert.equal(renamed.titleState?.source, "generated");
      assert.equal((yield* threadShell(T.routine)).title, "Morning briefing");
      assert.equal((yield* threadShell(T.mixed)).title, "Nightly check");
      // Everything else is exactly as it was.
      assert.equal((yield* threadShell(T.user)).title, "New chat");
      assert.equal((yield* threadShell(T.group)).title, "New chat");
      assert.equal((yield* threadShell(T.member)).title, "New chat");
      assert.equal((yield* threadShell(T.titled)).title, "Already named");
      const manual = yield* threadShell(T.manual);
      assert.equal(manual.title, "New chat");
      assert.equal(manual.titleState?.source, "manual");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("sets the marker only after a clean pass, and a later start does nothing", () =>
    Effect.gen(function* () {
      yield* seed;
      const engine = yield* OrchestrationEngineService;
      const flaky = {
        ...engine,
        dispatch: ((command) =>
          command.type === "thread.title.generate.complete" && command.threadId === T.routine
            ? Effect.die(new Error("store unavailable"))
            : engine.dispatch(command)) as typeof engine.dispatch,
      };

      // First start: one rename fails, so no marker and the rest are renamed.
      const first = yield* runTaskTitleBackfill().pipe(
        Effect.provideService(OrchestrationEngineService, flaky),
      );
      assert.deepEqual(first, {
        renamed: 2,
        skipped: { gone: 0, manual: 0, changed: 0 },
        failed: 1,
      });
      assert.isTrue(Option.isNone(yield* getMarker));
      assert.equal((yield* threadShell(T.routine)).title, "New chat");

      // Second start retries and only the failed chat is left to rename.
      const second = yield* runTaskTitleBackfill();
      assert.deepEqual(second, {
        renamed: 1,
        skipped: { gone: 0, manual: 0, changed: 0 },
        failed: 0,
      });
      assert.isTrue(Option.isSome(yield* getMarker));
      assert.equal((yield* threadShell(T.routine)).title, "Morning briefing");

      // Third start, marker set: a new qualifying chat is left alone.
      const late = ThreadId.make("thread-late");
      yield* createThread(late, 50);
      yield* insertTask({
        taskId: "task-late",
        title: "Late task",
        source: "delegation",
        createdAt: "2026-09-01T10:50:00.000Z",
        threadId: late,
      });
      const before = yield* listOrder;
      assert.isNull(yield* runTaskTitleBackfill());
      assert.equal((yield* threadShell(late)).title, "New chat");
      assert.deepEqual(yield* listOrder, before);
    }).pipe(Effect.provide(makeLayer())),
  );
});
