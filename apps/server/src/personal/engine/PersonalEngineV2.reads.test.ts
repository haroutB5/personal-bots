import {
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { runMigrations } from "../../persistence/Migrations.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { PersonalEngine } from "./PersonalEngine.ts";
import { PersonalEngineV2Live } from "./PersonalEngineV2Live.ts";

const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-test",
};
const AT = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");

const shellFor = (
  threadId: string,
  options: {
    latestRunId?: string | null;
    status?: OrchestrationV2ThreadShell["status"];
  } = {},
) =>
  ({
    createdBy: "server",
    creationSource: "server",
    id: ThreadId.make(threadId),
    projectId: ProjectId.make("project-1"),
    title: "Researcher",
    providerInstanceId: MODEL.instanceId,
    modelSelection: MODEL,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make(threadId),
    },
    forkedFrom: null,
    latestRunId: options.latestRunId ?? null,
    latestRunRequestedAt: options.latestRunId === undefined ? null : AT,
    latestRunStartedAt: null,
    latestRunCompletedAt: options.latestRunId === undefined ? null : AT,
    activeRunId: null,
    status: options.status ?? (options.latestRunId === undefined ? "idle" : "completed"),
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const messagePayload = (input: {
  messageId: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
  runId?: string | null;
  streaming?: boolean;
}) =>
  JSON.stringify({
    createdBy: "server",
    creationSource: "server",
    id: input.messageId,
    threadId: input.threadId,
    runId: input.runId ?? null,
    nodeId: null,
    role: input.role,
    text: input.text,
    attachments: [],
    streaming: input.streaming ?? false,
    createdAt: input.at,
    updatedAt: input.at,
  });

const insertMessage = (input: Parameters<typeof messagePayload>[0]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
          payload_json)
      VALUES (
        ${input.messageId}, ${input.threadId}, ${input.runId ?? null}, NULL, ${input.role},
        ${input.streaming === true ? 1 : 0}, ${input.at}, ${input.at}, ${messagePayload(input)}
      )
    `;
  });

const insertItem = (input: {
  id: string;
  threadId: string;
  ordinal: number;
  type: string;
  status?: string;
  at: string;
  payload: unknown;
  runId?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json)
      VALUES (
        ${input.id}, ${input.threadId}, ${input.runId ?? null}, NULL, NULL, NULL, NULL,
        ${input.ordinal}, ${input.type}, ${input.status ?? "completed"}, ${input.at},
        ${JSON.stringify({ type: input.type, ...(input.payload as object) })}
      )
    `;
  });

const insertThread = (input: { threadId: string; latestUserMessageAt?: string | null }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
          interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at,
          deleted_at, payload_json)
      VALUES (
        ${input.threadId}, 'project-1', 'Researcher', ${MODEL.instanceId},
        ${MODEL.instanceId}, ${DEFAULT_RUNTIME_MODE}, 'default', NULL,
        '2026-11-06T10:00:00.000Z', '2026-11-06T12:00:00.000Z', NULL, NULL,
        ${JSON.stringify({ latestUserMessageAt: input.latestUserMessageAt ?? null })}
      )
    `;
  });

const insertRun = (input: {
  threadId: string;
  runId: string;
  ordinal: number;
  status: string;
  requestedAt: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id, status,
          requested_at, completed_at, payload_json)
      VALUES (
        ${input.runId}, ${input.threadId}, ${input.ordinal}, ${MODEL.instanceId},
        ${MODEL.instanceId}, NULL, ${input.status}, ${input.requestedAt}, NULL, '{}'
      )
    `;
  });

const makeLayer = (shells: Map<string, OrchestrationV2ThreadShell>) => {
  const threadsApi = {
    getThreadShell: (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null),
    getShellSnapshot: (options?: { unsettledOnly?: boolean }) =>
      Effect.succeed({
        schemaVersion: 1,
        snapshotSequence: 1,
        threads: options?.unsettledOnly === true ? [] : [...shells.values()],
        archivedThreads: [],
      }),
    streamDomainEvents: Stream.empty,
  };
  const projectsApi = {
    create: () => Effect.die("unused"),
    getShell: () => Effect.succeed(Option.none()),
    listShells: () => Effect.succeed([]),
  };
  const eventSink = { write: () => Effect.succeed([]) };
  return PersonalEngineV2Live.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ThreadManagementService.ThreadManagementService, threadsApi as never),
        Layer.succeed(ProjectService, projectsApi as never),
        Layer.succeed(EventSinkV2, eventSink as never),
      ),
    ),
  );
};

const withEngine = <A, E>(
  shells: Map<string, OrchestrationV2ThreadShell>,
  program: (engine: PersonalEngine["Service"]) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 142 });
    const engine = yield* PersonalEngine;
    return yield* program(engine);
  }).pipe(Effect.provide(makeLayer(shells)));

describe("PersonalEngineV2 reads", () => {
  it.effect("listMessages returns the last limit before the cursor", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        yield* insertMessage({
          messageId: "m1",
          threadId: "thread-1",
          role: "user",
          text: "m1",
          at: "2026-11-06T10:00:00.000Z",
        });
        yield* insertMessage({
          messageId: "m2",
          threadId: "thread-1",
          role: "assistant",
          text: "m2",
          at: "2026-11-06T11:00:00.000Z",
        });
        yield* insertMessage({
          messageId: "m3",
          threadId: "thread-1",
          role: "user",
          text: "m3",
          at: "2026-11-06T12:00:00.000Z",
        });
        yield* insertMessage({
          messageId: "other",
          threadId: "thread-2",
          role: "user",
          text: "other",
          at: "2026-11-06T12:30:00.000Z",
        });

        const lastTwo = yield* engine.listMessages({
          threadId: ThreadId.make("thread-1"),
          limit: 2,
        });
        expect(lastTwo.map((message) => message.text)).toEqual(["m2", "m3"]);

        const before = yield* engine.listMessages({
          threadId: ThreadId.make("thread-1"),
          limit: 5,
          before: DateTime.makeUnsafe("2026-11-06T11:30:00.000Z"),
        });
        expect(before.map((message) => message.text)).toEqual(["m1", "m2"]);

        const none = yield* engine.listMessages({
          threadId: ThreadId.make("thread-1"),
          limit: 0,
        });
        expect(none).toEqual([]);
      }),
    );
  });

  it.effect("latestAssistantMessage honours after, message tie-break and turn", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        yield* insertMessage({
          messageId: "user-1",
          threadId: "thread-1",
          role: "user",
          text: "question",
          at: "2026-11-06T10:00:00.000Z",
        });
        yield* insertMessage({
          messageId: "assistant-1",
          threadId: "thread-1",
          role: "assistant",
          text: "first",
          at: "2026-11-06T10:01:00.000Z",
          runId: "run-1",
        });
        yield* insertMessage({
          messageId: "assistant-2",
          threadId: "thread-1",
          role: "assistant",
          text: "second",
          at: "2026-11-06T10:02:00.000Z",
          runId: "run-2",
        });

        const latest = yield* engine.latestAssistantMessage({
          threadId: ThreadId.make("thread-1"),
        });
        expect(Option.getOrThrow(latest).text).toBe("second");

        const after = yield* engine.latestAssistantMessage({
          threadId: ThreadId.make("thread-1"),
          after: DateTime.makeUnsafe("2026-11-06T10:01:00.000Z"),
          afterMessageId: MessageId.make("assistant-1"),
        });
        expect(Option.getOrThrow(after).text).toBe("second");

        const turn = yield* engine.latestAssistantMessage({
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("run-1"),
        });
        expect(Option.getOrThrow(turn).text).toBe("first");

        const none = yield* engine.latestAssistantMessage({
          threadId: ThreadId.make("thread-1"),
          after: DateTime.makeUnsafe("2026-11-06T10:02:00.000Z"),
        });
        expect(Option.isNone(none)).toBe(true);
      }),
    );
  });

  it.effect("latestUserMessage skips the server's generated prefix", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        yield* insertMessage({
          messageId: "owner-1",
          threadId: "thread-1",
          role: "user",
          text: "owner",
          at: "2026-11-06T10:00:00.000Z",
        });
        yield* insertMessage({
          messageId: "task-2",
          threadId: "thread-1",
          role: "user",
          text: "task",
          at: "2026-11-06T11:00:00.000Z",
        });
        const owner = yield* engine.latestUserMessage({
          threadId: ThreadId.make("thread-1"),
          excludeIdPrefix: "task-",
        });
        expect(Option.getOrThrow(owner).text).toBe("owner");
      }),
    );
  });

  it.effect("messageById and messagesByIds read named rows only", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        yield* insertMessage({
          messageId: "m1",
          threadId: "thread-1",
          role: "user",
          text: "one",
          at: "2026-11-06T10:00:00.000Z",
        });
        yield* insertMessage({
          messageId: "m2",
          threadId: "thread-1",
          role: "assistant",
          text: "two",
          at: "2026-11-06T11:00:00.000Z",
        });
        yield* insertMessage({
          messageId: "m3",
          threadId: "thread-2",
          role: "user",
          text: "other",
          at: "2026-11-06T12:00:00.000Z",
        });

        const found = yield* engine.messageById(MessageId.make("m2"));
        expect(Option.getOrThrow(found)).toMatchObject({ text: "two", role: "assistant" });
        expect(Option.isNone(yield* engine.messageById(MessageId.make("missing")))).toBe(true);

        const named = yield* engine.messagesByIds({
          threadId: ThreadId.make("thread-1"),
          messageIds: [MessageId.make("m2"), MessageId.make("m1"), MessageId.make("m3")],
        });
        expect(named.map((message) => message.text)).toEqual(["one", "two"]);
      }),
    );
  });

  it.effect("activity reads come from turn items", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        yield* insertItem({
          id: "item-1",
          threadId: "thread-1",
          ordinal: 1,
          type: "command_execution",
          at: "2026-11-06T10:00:00.000Z",
          payload: { title: "Command run", input: "curl https://example.com" },
        });
        yield* insertItem({
          id: "item-2",
          threadId: "thread-1",
          ordinal: 2,
          type: "web_search",
          at: "2026-11-06T10:01:00.000Z",
          payload: { patterns: ["bots"] },
        });
        yield* insertItem({
          id: "item-3",
          threadId: "thread-1",
          ordinal: 3,
          type: "compaction",
          at: "2026-11-06T10:02:00.000Z",
          payload: { driver: "claudeAgent" },
        });

        const used = yield* engine.threadUsedWeb({
          threadId: ThreadId.make("thread-1"),
          needles: ["example.com"],
        });
        expect(used).toBe(true);
        const notUsed = yield* engine.threadUsedWeb({
          threadId: ThreadId.make("thread-2"),
          needles: ["unrelated"],
        });
        expect(notUsed).toBe(false);

        const steps = yield* engine.toolStepsSince({
          threadId: ThreadId.make("thread-1"),
          since: "2026-11-06T09:00:00.000Z",
          limit: 10,
        });
        expect(steps.map((step) => [step.id, step.itemType])).toEqual([
          ["item-2", "web_search"],
          ["item-1", "command_execution"],
        ]);

        const compacted = yield* engine.compactedSince({
          threadId: ThreadId.make("thread-1"),
          since: "2026-11-06T09:00:00.000Z",
        });
        expect(compacted).toBe(true);

        const byId = yield* engine.activitiesByIds({
          threadId: ThreadId.make("thread-1"),
          ids: ["item-1", "missing"],
        });
        expect(byId).toHaveLength(1);
        expect(byId[0]).toMatchObject({ id: "item-1", kind: "command_execution" });
      }),
    );
  });

  it.effect("latestContextTokens reads the newest provider turn", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_turns
            (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal,
              status, started_at, completed_at, payload_json)
          VALUES
            ('turn-1', 'thread-1', 'provider-thread-1', 'node-1', NULL, 1, 'completed',
              '2026-11-06T10:00:00.000Z', '2026-11-06T10:01:00.000Z',
              '{"tokenUsage":{"usedTokens":100}}'),
            ('turn-2', 'thread-1', 'provider-thread-1', 'node-1', NULL, 2, 'completed',
              '2026-11-06T11:00:00.000Z', '2026-11-06T11:01:00.000Z',
              '{"tokenUsage":{"usedTokens":4200}}')
        `;
        const tokens = yield* engine.latestContextTokens(ThreadId.make("thread-1"));
        expect(tokens).toBe(4200);
      }),
    );
  });

  it.effect("latestRunInterruptReason reads the interrupt result of the newest run only", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make("thread-1");
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
              completed_at, payload_json)
          VALUES
            ('run-1', 'thread-1', 1, 'opencode', 'provider-thread-1', 'interrupted',
              '2026-11-06T10:00:00.000Z', '2026-11-06T10:01:00.000Z', '{}'),
            ('run-2', 'thread-1', 2, 'opencode', 'provider-thread-1', 'completed',
              '2026-11-06T11:00:00.000Z', '2026-11-06T11:01:00.000Z', '{}')
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json)
          VALUES
            ('item-1', 'thread-1', 'run-1', NULL, NULL, NULL, NULL, 1, 'run_interrupt_result',
              'completed', '2026-11-06T10:01:00.000Z', '{"message":"provider-server-lost"}')
        `;
        expect(yield* engine.latestRunInterruptReason(thread)).toBeNull();
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs
            (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
              completed_at, payload_json)
          VALUES ('run-3', 'thread-1', 3, 'opencode', 'provider-thread-1', 'interrupted',
            '2026-11-06T12:00:00.000Z', '2026-11-06T12:01:00.000Z', '{}')
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
            (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json)
          VALUES
            ('item-3', 'thread-1', 'run-3', NULL, NULL, NULL, NULL, 2, 'run_interrupt_result',
              'completed', '2026-11-06T12:01:00.000Z', '{"message":"provider-server-lost"}')
        `;
        expect(yield* engine.latestRunInterruptReason(thread)).toBe("provider-server-lost");
        expect(yield* engine.latestRunInterruptReason(ThreadId.make("thread-2"))).toBeNull();
      }),
    );
  });

  it.effect("continuationTurn follows runs that continue a turn up to the loop-guard depth", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const thread = ThreadId.make("thread-1");
        const insertRun = (
          id: string,
          ordinal: number,
          continues?: string,
          threadId = "thread-1",
        ) =>
          sql`
            INSERT INTO orchestration_v2_projection_runs
              (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
                completed_at, payload_json)
            VALUES (${id}, ${threadId}, ${ordinal}, 'opencode', 'provider-thread-1', 'interrupted',
              '2026-11-06T10:00:00.000Z', '2026-11-06T10:01:00.000Z',
              ${continues === undefined ? "{}" : JSON.stringify({ restartContinuationOfRunId: continues })})
          `;
        const continuationOf = (runId: string) =>
          engine.continuationTurn({ threadId: thread, turnId: TurnId.make(runId) });

        yield* insertRun("run-1", 1);
        expect(yield* continuationOf("run-1")).toBeNull();

        yield* insertRun("run-2", 2, "run-1");
        expect(yield* continuationOf("run-1")).toBe("run-2");
        expect(yield* continuationOf("run-2")).toBeNull();

        yield* insertRun("run-3", 3, "run-2");
        expect(yield* continuationOf("run-1")).toBe("run-3");
        expect(yield* continuationOf("run-2")).toBe("run-3");

        yield* insertRun("run-4", 4, "run-3");
        yield* insertRun("run-5", 5, "run-4");
        expect(yield* continuationOf("run-1")).toBe("run-4");
        expect(yield* continuationOf("run-4")).toBe("run-5");

        yield* insertRun("run-x", 1, undefined, "thread-2");
        yield* insertRun("run-y", 2, "run-x", "thread-2");
        expect(yield* continuationOf("run-x")).toBeNull();
      }),
    );
  });

  it.effect("shellSnapshot maps every v2 shell, archived included", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>([
      ["thread-1", shellFor("thread-1", { latestRunId: "run-1" })],
      ["thread-2", shellFor("thread-2")],
    ]);
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_threads
            (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id,
              provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at,
              payload_json)
          VALUES
            ('provider-thread-1', 'thread-1', NULL, ${MODEL.instanceId}, 'claudeAgent',
              ${MODEL.instanceId}, NULL, 'ready', 1, 1, '2026-11-06T12:00:00.000Z',
              '{}')
        `;
        const mapped = yield* engine.shellSnapshot({ unsettledOnly: false });
        expect(mapped.map((shell) => shell.id)).toEqual(["thread-1", "thread-2"]);
        expect(mapped[0]?.session).toMatchObject({
          providerName: "claudeAgent",
          providerInstanceId: MODEL.instanceId,
        });
        expect(mapped[1]?.session).toBeNull();
        expect(mapped[0]?.latestTurn).toMatchObject({
          turnId: "run-1",
          state: "completed",
        });
      }),
    );
  });

  it.effect("workingSnapshot reads the live reasoning and tool step", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        yield* insertThread({
          threadId: "thread-1",
          latestUserMessageAt: "2026-11-06T10:00:00.000Z",
        });
        yield* insertRun({
          threadId: "thread-1",
          runId: "run-1",
          ordinal: 1,
          status: "running",
          requestedAt: "2026-11-06T09:00:00.000Z",
        });
        yield* insertItem({
          id: "reason-1",
          threadId: "thread-1",
          ordinal: 1,
          type: "reasoning",
          at: "2026-11-06T10:01:00.000Z",
          payload: { text: "thinking about it", streaming: true },
        });
        yield* insertItem({
          id: "tool-1",
          threadId: "thread-1",
          ordinal: 2,
          type: "command_execution",
          at: "2026-11-06T10:02:00.000Z",
          payload: { title: "Run tests", input: "vp test" },
        });

        const rows = yield* engine.workingSnapshot([ThreadId.make("thread-1")]);
        expect(rows).toEqual([
          {
            threadId: "thread-1",
            turnId: "run-1",
            reasoningText: "thinking about it",
            reasoningAt: "2026-11-06T10:01:00.000Z",
            toolTitle: "Run tests",
            toolSummary: "Run tests",
            toolAt: "2026-11-06T10:02:00.000Z",
          },
        ]);
      }),
    );
  });

  it.effect("workingSnapshot picks the waiting question over the tool that asked it", () => {
    const shells = new Map<string, OrchestrationV2ThreadShell>();
    return withEngine(shells, (engine) =>
      Effect.gen(function* () {
        yield* insertThread({
          threadId: "thread-1",
          latestUserMessageAt: "2026-11-06T10:00:00.000Z",
        });
        yield* insertRun({
          threadId: "thread-1",
          runId: "run-1",
          ordinal: 1,
          status: "running",
          requestedAt: "2026-11-06T09:00:00.000Z",
        });
        yield* insertItem({
          id: "tool-1",
          threadId: "thread-1",
          ordinal: 1,
          type: "dynamic_tool",
          at: "2026-11-06T10:02:00.000Z",
          payload: { title: null, toolName: "AskUserQuestion" },
        });
        yield* insertItem({
          id: "ask-1",
          threadId: "thread-1",
          ordinal: 2,
          type: "user_input_request",
          status: "waiting",
          at: "2026-11-06T10:03:00.000Z",
          payload: { title: null, requestId: "request-1", questions: [] },
        });

        const rows = yield* engine.workingSnapshot([ThreadId.make("thread-1")]);
        expect(rows).toEqual([
          {
            threadId: "thread-1",
            turnId: "run-1",
            reasoningText: null,
            reasoningAt: null,
            toolTitle: null,
            toolSummary: "user_input_request",
            toolAt: "2026-11-06T10:03:00.000Z",
          },
        ]);
      }),
    );
  });
});
