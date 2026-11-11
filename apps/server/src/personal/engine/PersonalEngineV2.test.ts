import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  PersonalTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { runMigrations } from "../../persistence/Migrations.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { personalTaskMessageContext } from "../tasks/taskShared.ts";
import { PersonalEngine, type PersonalThreadEvent } from "./PersonalEngine.ts";
import { PersonalEngineV2Live } from "./PersonalEngineV2Live.ts";

const ISO = "2026-11-06T12:00:00.000Z";
const AT = DateTime.makeUnsafe(ISO);
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-test",
};
const ATTACHMENTS: ReadonlyArray<ChatAttachment> = [];

const shellFor = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly status?: OrchestrationV2ThreadShell["status"];
  readonly latestRunId?: RunId | null;
  readonly activeRunId?: RunId | null;
  readonly archived?: boolean;
  readonly deleted?: boolean;
}): OrchestrationV2ThreadShell =>
  ({
    createdBy: "system",
    creationSource: "server",
    id: input.threadId,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId: MODEL.instanceId,
    modelSelection: MODEL,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    pullRequests: [],
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    latestRunId: input.latestRunId ?? null,
    activeRunId: input.activeRunId ?? null,
    status: input.status ?? "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: input.archived === true ? AT : null,
    settledOverride: null,
    settledAt: null,
    deletedAt: input.deleted === true ? AT : null,
  }) as unknown as OrchestrationV2ThreadShell;

const runFor = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly status: OrchestrationV2Run["status"];
  readonly ordinal: number;
}): OrchestrationV2Run =>
  ({
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: MODEL.instanceId,
    modelSelection: MODEL,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${input.ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: AT,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  }) as unknown as OrchestrationV2Run;

interface Harness {
  readonly threads: Map<
    string,
    { shell: OrchestrationV2ThreadShell; runs: Array<OrchestrationV2Run> }
  >;
  readonly projects: Map<string, { id: ProjectId; workspaceRoot: string; title: string }>;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  readonly written: Array<OrchestrationV2DomainEvent>;
  readonly interrupts: Array<{ threadId: string; runId: string | null }>;
  readonly snapshotOptions: Array<{ unsettledOnly?: boolean }>;
  readonly pubsub: PubSub.PubSub<OrchestrationV2DomainEvent>;
  readonly threadsApi: unknown;
  readonly projectsApi: unknown;
  readonly eventSink: unknown;
}

const makeHarness = (): Harness => {
  const threads: Harness["threads"] = new Map();
  const projects: Harness["projects"] = new Map();
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const written: Array<OrchestrationV2DomainEvent> = [];
  const interrupts: Harness["interrupts"] = [];
  const snapshotOptions: Harness["snapshotOptions"] = [];
  // The harness is synchronous; every test builds its engine inside it.effect.
  const pubsub = Effect.runSync(PubSub.unbounded<OrchestrationV2DomainEvent>());

  const apply = (command: OrchestrationV2ServerCommand) => {
    switch (command.type) {
      case "thread.create":
        threads.set(command.threadId, {
          shell: shellFor({
            threadId: command.threadId,
            projectId: command.projectId,
            title: command.title,
          }),
          runs: [],
        });
        return;
      case "thread.metadata.update": {
        const record = threads.get(command.threadId);
        if (record === undefined) return;
        record.shell = {
          ...record.shell,
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.branch === undefined ? {} : { branch: command.branch }),
          ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
        };
        return;
      }
      case "thread.model-selection.set": {
        const record = threads.get(command.threadId);
        if (record === undefined) return;
        record.shell = { ...record.shell, modelSelection: command.modelSelection };
        return;
      }
      case "thread.archive": {
        const record = threads.get(command.threadId);
        if (record === undefined) return;
        record.shell = { ...record.shell, archivedAt: AT };
        return;
      }
      case "thread.delete":
        threads.delete(command.threadId);
        return;
      case "thread.stop": {
        const record = threads.get(command.threadId);
        if (record === undefined) return;
        record.shell = { ...record.shell, status: "idle", activeRunId: null };
        return;
      }
      default:
        return;
    }
  };

  const threadsApi = {
    dispatch: (command: OrchestrationV2ServerCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        apply(command);
        return { sequence: dispatched.length };
      }),
    getThreadShell: (threadId: ThreadId) => Effect.succeed(threads.get(threadId)?.shell ?? null),
    getThreadRecords: (threadId: ThreadId, fields: ReadonlyArray<string>) =>
      Effect.sync(() => {
        const record = threads.get(threadId);
        if (record === undefined) throw new Error(`no thread ${threadId}`);
        return {
          thread: record.shell,
          ...Object.fromEntries(fields.map((field) => [field, record.runs])),
        };
      }),
    getShellSnapshot: (options?: { unsettledOnly?: boolean }) => {
      snapshotOptions.push(options ?? {});
      return Effect.succeed({
        schemaVersion: 1,
        snapshotSequence: 1,
        threads: [...threads.values()].map((record) => record.shell),
        archivedThreads: [],
      });
    },
    interruptThread: (input: { threadId: ThreadId; runId?: RunId }) => {
      interrupts.push({
        threadId: input.threadId,
        runId: input.runId === undefined ? null : input.runId,
      });
      return Effect.succeed({ type: "no_active_run" as const });
    },
    streamDomainEvents: Stream.fromPubSub(pubsub),
  };

  const projectsApi = {
    create: (input: { projectId: ProjectId; title: string; workspaceRoot: string }) =>
      Effect.sync(() => {
        projects.set(input.projectId, {
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
        });
        return {
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: ISO,
          updatedAt: ISO,
          deletedAt: null,
        };
      }),
    getShell: (projectId: ProjectId) =>
      Effect.succeed(Option.fromNullishOr(projects.get(projectId))),
    listShells: () => Effect.succeed([...projects.values()]),
  };

  const eventSink = {
    write: (input: { events: ReadonlyArray<OrchestrationV2DomainEvent> }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        written.push(...input.events);
        for (const event of input.events) {
          if (event.type !== "message.updated") continue;
          const payload = event.payload;
          const stored = JSON.stringify({
            ...payload,
            createdAt: DateTime.formatIso(payload.createdAt),
            updatedAt: DateTime.formatIso(payload.updatedAt),
          });
          yield* sql`
            INSERT INTO orchestration_v2_projection_messages
              (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
                payload_json)
            VALUES (
              ${payload.id}, ${payload.threadId}, ${payload.runId}, ${payload.nodeId},
              ${payload.role}, ${payload.streaming ? 1 : 0},
              ${DateTime.formatIso(payload.createdAt)}, ${DateTime.formatIso(payload.updatedAt)},
              ${stored}
            )
            ON CONFLICT(message_id) DO UPDATE SET
              role = excluded.role,
              streaming = excluded.streaming,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `;
        }
        return [];
      }),
  };

  return {
    threads,
    projects,
    dispatched,
    written,
    interrupts,
    snapshotOptions,
    pubsub,
    threadsApi,
    projectsApi,
    eventSink,
  };
};

const layerFor = (harness: Harness) =>
  PersonalEngineV2Live.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ThreadManagementService.ThreadManagementService, harness.threadsApi as never),
        Layer.succeed(ProjectService, harness.projectsApi as never),
        Layer.succeed(EventSinkV2, harness.eventSink as never),
      ),
    ),
  );

const withEngine = <A, E, R = never>(
  harness: Harness,
  program: (engine: PersonalEngine["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 142 });
    const engine = yield* PersonalEngine;
    return yield* program(engine);
  }).pipe(Effect.provide(layerFor(harness)));

const seedThread = (harness: Harness, threadId = "thread-1", title = "Researcher") =>
  Effect.sync(() => {
    harness.threads.set(threadId, {
      shell: shellFor({
        threadId: ThreadId.make(threadId),
        projectId: ProjectId.make("project-1"),
        title,
      }),
      runs: [],
    });
  });

const seedRun = (
  harness: Harness,
  threadId: string,
  runId: string,
  status: OrchestrationV2Run["status"],
) =>
  Effect.sync(() => {
    const record = harness.threads.get(threadId);
    if (record === undefined) throw new Error(`no thread ${threadId}`);
    record.runs.push(
      runFor({
        threadId: ThreadId.make(threadId),
        runId: RunId.make(runId),
        status,
        ordinal: record.runs.length + 1,
      }),
    );
    record.shell = {
      ...record.shell,
      status,
      latestRunId: RunId.make(runId),
      activeRunId: status === "running" ? RunId.make(runId) : null,
    };
  });

describe("PersonalEngineV2 verbs", () => {
  it.effect("createProject writes the project and returns its id", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        const projectId = yield* engine.createProject({
          projectId: ProjectId.make("project-1"),
          title: "Bots",
          workspaceRoot: "/work/bots",
        });
        expect(projectId).toBe("project-1");
        expect([...harness.projects.values()]).toEqual([
          { id: "project-1", title: "Bots", workspaceRoot: "/work/bots" },
        ]);
        const projects = yield* engine.listProjects();
        expect(projects).toEqual([{ id: "project-1", workspaceRoot: "/work/bots" }]);
      }),
    );
  });

  it.effect("createThread dispatches the v2 create and getThread reads it back", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        const threadId = yield* engine.createThread({
          projectId: ProjectId.make("project-1"),
          title: "Researcher",
          modelSelection: MODEL,
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        const command = harness.dispatched[0];
        expect(command).toMatchObject({
          type: "thread.create",
          threadId,
          projectId: "project-1",
          title: "Researcher",
          createdBy: "system",
          creationSource: "server",
        });

        const thread = yield* engine.getThread(threadId);
        expect(Option.getOrThrow(thread)).toMatchObject({
          id: threadId,
          projectId: "project-1",
          title: "Researcher",
          session: null,
        });
      }),
    );
  });

  it.effect("send refuses a deleted thread before dispatch", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        harness.threads.set("thread-1", {
          shell: shellFor({
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-1"),
            title: "Gone",
            deleted: true,
          }),
          runs: [],
        });
        const error = yield* engine
          .send({
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("message-1"),
            text: "hello",
            attachments: ATTACHMENTS,
            mode: "start",
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "PersonalEngineError", operation: "send" });
        expect(error.detail).toContain("is deleted");
        expect(harness.dispatched).toHaveLength(0);
      }),
    );
  });

  it.effect("send start, queue and steer choose the v2 dispatch mode", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* seedRun(harness, "thread-1", "run-1", "running");

        for (const [index, mode] of (["start", "queue", "steer"] as const).entries()) {
          yield* engine.send({
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make(`message-${index}`),
            text: `hello ${mode}`,
            attachments: ATTACHMENTS,
            mode,
          });
        }

        const commands = harness.dispatched.filter(
          (command) => command.type === "message.dispatch",
        );
        expect(
          commands.map((command) => command.type === "message.dispatch" && command.dispatchMode),
        ).toEqual([
          { type: "start_immediately" },
          { type: "queue_after_active" },
          { type: "steer_active", targetRunId: "run-1" },
        ]);
      }),
    );
  });

  it.effect("a fresh task turn asks v2 for a fresh session", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* engine.send({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("personal-task-task-1-2"),
          text: "Continue the task",
          attachments: ATTACHMENTS,
          context: personalTaskMessageContext({
            taskId: PersonalTaskId.make("task-1"),
            attempt: 2,
            turn: "continuation",
            source: "user",
            title: "Long task",
            delegatorBotId: null,
            fresh: true,
            children: [],
          }),
          mode: "start",
        });
        const command = harness.dispatched.find(
          (candidate) => candidate.type === "message.dispatch",
        );
        expect(command).toMatchObject({ freshContext: true });
      }),
    );
  });

  it.effect(
    "a first-message seed names a placeholder chat but never a manual or task title",
    () => {
      const harness = makeHarness();
      return withEngine(harness, (engine) =>
        Effect.gen(function* () {
          yield* seedThread(harness, "thread-placeholder", "New chat");
          yield* engine.send({
            threadId: ThreadId.make("thread-placeholder"),
            messageId: MessageId.make("message-seed"),
            text: "Fix the build",
            attachments: ATTACHMENTS,
            titleSeed: "Fix the build",
            mode: "start",
          });
          const seeded = harness.dispatched.findLast(
            (candidate) => candidate.type === "message.dispatch",
          );
          expect(seeded).toMatchObject({ titleSeed: "Fix the build" });

          yield* seedThread(harness, "thread-manual", "Owner named");
          yield* engine.updateMeta({
            threadId: ThreadId.make("thread-manual"),
            title: "Owner named",
          });
          yield* engine.send({
            threadId: ThreadId.make("thread-manual"),
            messageId: MessageId.make("message-manual"),
            text: "Fix the build",
            attachments: ATTACHMENTS,
            titleSeed: "Fix the build",
            mode: "start",
          });
          const manual = harness.dispatched.findLast(
            (candidate) => candidate.type === "message.dispatch",
          );
          expect(
            manual?.type === "message.dispatch" ? manual.titleSeed : "missing",
          ).toBeUndefined();

          yield* seedThread(harness, "thread-task", "New chat");
          yield* engine.send({
            threadId: ThreadId.make("thread-task"),
            messageId: MessageId.make("personal-task-task-2-1"),
            text: "Task turn",
            attachments: ATTACHMENTS,
            titleSeed: "Task title",
            mode: "start",
          });
          const task = harness.dispatched.findLast(
            (candidate) => candidate.type === "message.dispatch",
          );
          expect(task?.type === "message.dispatch" ? task.titleSeed : "missing").toBeUndefined();
        }),
      );
    },
  );

  it.effect("a continuation carries the selection its caller read from the bot", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* engine.continueTurn({
          threadId: ThreadId.make("thread-1"),
          interactionMode: "default",
          modelSelection: MODEL,
        });
        const command = harness.dispatched.find(
          (candidate) => candidate.type === "message.dispatch",
        );
        expect(command).toMatchObject({ modelSelection: MODEL });
      }),
    );
  });

  it.effect("steer on an idle thread starts a turn", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* engine.send({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("message-1"),
          text: "hello",
          attachments: ATTACHMENTS,
          mode: "steer",
        });
        expect(harness.dispatched[0]).toMatchObject({
          type: "message.dispatch",
          dispatchMode: { type: "start_immediately" },
        });
      }),
    );
  });

  it.effect("a continuation is promptless on Codex and carries the fallback prompt elsewhere", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* withEngine(harness, (engine) =>
        Effect.gen(function* () {
          yield* seedThread(harness, "thread-codex");
          yield* seedThread(harness, "thread-claude");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            INSERT INTO orchestration_v2_projection_provider_threads
              (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
                first_run_ordinal, last_run_ordinal, updated_at, payload_json)
            VALUES ('pt-codex', 'thread-codex', NULL, 'codex', NULL, 'active', 1, 1,
              '2026-11-06T12:00:00.000Z', '{}')
          `;
          yield* sql`
            INSERT INTO orchestration_v2_projection_provider_threads
              (provider_thread_id, thread_id, owner_node_id, provider, provider_session_id, status,
                first_run_ordinal, last_run_ordinal, updated_at, payload_json)
            VALUES ('pt-claude', 'thread-claude', NULL, 'claudeAgent', NULL, 'active', 1, 1,
              '2026-11-06T12:00:00.000Z', '{}')
          `;
          yield* engine.continueTurn({
            threadId: ThreadId.make("thread-codex"),
            interactionMode: "default",
          });
          yield* engine.continueTurn({
            threadId: ThreadId.make("thread-claude"),
            interactionMode: "default",
          });
        }),
      );
      const dispatched = harness.dispatched.filter(
        (command) => command.type === "message.dispatch",
      );
      expect(dispatched.map((command) => command.text)).toEqual([
        "",
        "Continue where you left off.",
      ]);
    }),
  );

  it.effect("interrupt, stop, archive and delete reach the v2 commands", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* seedRun(harness, "thread-1", "run-1", "running");

        yield* engine.interrupt(ThreadId.make("thread-1"), TurnId.make("run-1"));
        expect(harness.interrupts).toEqual([{ threadId: "thread-1", runId: "run-1" }]);

        yield* engine.stop({
          threadId: ThreadId.make("thread-1"),
          terminateProcesses: true,
        });
        expect(harness.dispatched.at(-1)).toMatchObject({
          type: "thread.stop",
          threadId: "thread-1",
          stopDelegatedTasks: false,
        });

        yield* engine.archive(ThreadId.make("thread-1"));
        expect(harness.dispatched.at(-1)).toMatchObject({ type: "thread.archive" });

        yield* engine.deleteThread(ThreadId.make("thread-1"));
        expect(harness.dispatched.at(-1)).toMatchObject({ type: "thread.delete" });
      }),
    );
  });

  it.effect(
    "cancelQueuedMessages cancels only the queued runs whose message has the prefix",
    () => {
      const harness = makeHarness();
      return withEngine(harness, (engine) =>
        Effect.gen(function* () {
          yield* seedThread(harness);
          yield* seedRun(harness, "thread-1", "run-active", "running");
          yield* seedRun(harness, "thread-1", "run-steer", "queued");
          yield* seedRun(harness, "thread-1", "run-other", "queued");
          yield* seedRun(harness, "thread-1", "run-steer-started", "completed");
          const runs = harness.threads.get("thread-1")!.runs;
          const withMessage = (runId: string, messageId: string) => {
            const index = runs.findIndex((run) => run.id === runId);
            runs[index] = { ...runs[index]!, userMessageId: MessageId.make(messageId) };
          };
          withMessage("run-active", "personal-task-thread-1-1");
          withMessage("run-steer", "personal-task-steer-abc");
          withMessage("run-other", "message-from-the-owner");
          withMessage("run-steer-started", "personal-task-steer-def");

          yield* engine.cancelQueuedMessages({
            threadId: ThreadId.make("thread-1"),
            messageIdPrefix: "personal-task-steer-",
          });

          expect(harness.dispatched).toMatchObject([
            { type: "queued-run.cancel", threadId: "thread-1", runId: "run-steer" },
          ]);
        }),
      );
    },
  );

  it.effect("updateMeta writes title, branch and model as v2 commands", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* engine.updateMeta({
          threadId: ThreadId.make("thread-1"),
          title: "Renamed",
          branch: "feat/x",
          modelSelection: { ...MODEL, model: "claude-next" },
        });
        const updates = harness.dispatched.filter(
          (command) =>
            command.type === "thread.metadata.update" ||
            command.type === "thread.model-selection.set",
        );
        expect(updates).toHaveLength(2);
        expect(updates[0]).toMatchObject({
          type: "thread.metadata.update",
          title: "Renamed",
          branch: "feat/x",
        });
        expect(updates[0]).not.toHaveProperty("worktreePath");
        expect(updates[1]).toMatchObject({
          type: "thread.model-selection.set",
          modelSelection: { instanceId: "claudeAgent", model: "claude-next" },
        });
      }),
    );
  });

  it.effect("renameThreadIfUnchanged writes only while the title still matches", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* engine.renameThreadIfUnchanged({
          threadId: ThreadId.make("thread-1"),
          title: "Fix the login bug",
          expectedTitle: "Someone else renamed it",
          expectedVersion: CommandId.make("command-1"),
        });
        expect(harness.dispatched).toHaveLength(0);

        yield* engine.renameThreadIfUnchanged({
          threadId: ThreadId.make("thread-1"),
          title: "Fix the login bug",
          expectedTitle: "Researcher",
          expectedVersion: CommandId.make("command-1"),
        });
        expect(harness.dispatched).toHaveLength(1);
        expect(harness.dispatched[0]).toMatchObject({
          type: "thread.metadata.update",
          threadId: "thread-1",
          title: "Fix the login bug",
        });
      }),
    );
  });

  it.effect("setProviderRetry writes and clears the personal marker", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* seedRun(harness, "thread-1", "run-1", "failed");

        yield* engine.setProviderRetry({
          threadId: ThreadId.make("thread-1"),
          retry: {
            auto: "pending",
            attempt: 2,
            maxAttempts: 5,
            retryAt: "2026-11-06T12:00:30.000Z",
          },
        });
        const marked = yield* engine.getThread(ThreadId.make("thread-1"));
        expect(Option.getOrThrow(marked).session?.providerRetry).toMatchObject({
          kind: "retrying",
          auto: "pending",
          attempt: 2,
          maxAttempts: 5,
          retryAt: "2026-11-06T12:00:30.000Z",
          provider: "provider",
        });

        yield* engine.setProviderRetry({
          threadId: ThreadId.make("thread-1"),
          retry: null,
        });
        const cleared = yield* engine.getThread(ThreadId.make("thread-1"));
        expect(Option.getOrThrow(cleared).session?.providerRetry).toBeUndefined();
      }),
    );
  });
});

describe("PersonalEngineV2 notices", () => {
  it.effect("postNotice writes one finished assistant message and no turn", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* engine.postNotice({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("notice-1"),
          text: "Saved to memory.",
        });

        expect(harness.written.map((event) => event.type)).toEqual([
          "message.updated",
          "message.updated",
        ]);
        const [first, second] = harness.written;
        expect(first?.type === "message.updated" ? first.payload : null).toMatchObject({
          id: "notice-1",
          role: "assistant",
          text: "Saved to memory.",
          streaming: true,
          runId: null,
        });
        expect(second?.type === "message.updated" ? second.payload : null).toMatchObject({
          id: "notice-1",
          role: "assistant",
          text: "Saved to memory.",
          streaming: false,
          runId: null,
        });
        expect(harness.dispatched).toHaveLength(0);
      }),
    );
  });

  it.effect("postNotice carries the message context the caller passed", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* engine.postNotice({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("notice-context"),
          text: "Task update.",
          context: { version: 1, records: [] },
        });
        expect(harness.written[0]).toMatchObject({
          type: "message.updated",
          payload: { context: { version: 1, records: [] } },
        });
      }),
    );
  });

  it.effect("appendNotice applies a chunk once per key and completeNotice closes it", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* engine.appendNotice({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("notice-2"),
          delta: "Saved ",
          key: "chunk-1",
        });
        yield* engine.appendNotice({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("notice-2"),
          delta: "Saved ",
          key: "chunk-1",
        });
        yield* engine.completeNotice({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("notice-2"),
        });

        const texts = harness.written.map((event) =>
          event.type === "message.updated" ? event.payload.text : null,
        );
        expect(texts).toEqual(["Saved ", "Saved "]);
        expect(harness.written.at(-1)).toMatchObject({
          type: "message.updated",
          payload: { streaming: false },
        });
      }),
    );
  });

  it.effect("postUserMessage writes a user message with no run", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* engine.postUserMessage({
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("user-1"),
          text: "Relayed from the group.",
        });
        expect(harness.written[0]).toMatchObject({
          type: "message.updated",
          payload: { role: "user", runId: null, text: "Relayed from the group." },
        });
      }),
    );
  });
});

describe("PersonalEngineV2 events", () => {
  it.effect("a user message starts a turn and reports the message once", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(engine.events, 2)));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        yield* PubSub.publish(harness.pubsub, {
          id: EventId.make("event-1"),
          threadId: ThreadId.make("thread-1"),
          occurredAt: AT,
          driver: ProviderDriverKind.make("claudeAgent"),
          type: "message.updated",
          payload: {
            createdBy: "system",
            creationSource: "server",
            id: MessageId.make("user-1"),
            threadId: ThreadId.make("thread-1"),
            runId: RunId.make("run-1"),
            nodeId: null,
            role: "user",
            text: "hello",
            attachments: [],
            streaming: false,
            createdAt: AT,
            updatedAt: AT,
          },
        } as OrchestrationV2DomainEvent);

        const events = Array.from(yield* Fiber.join(collected)) as Array<PersonalThreadEvent>;
        expect(events.map((event) => event._tag)).toEqual(["TurnStartRequested", "MessageSent"]);
        expect(events[0]).toMatchObject({ messageId: "user-1", interactionMode: "default" });
      }),
    );
  });

  it.effect("a terminal run reports status and one turn end", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* seedRun(harness, "thread-1", "run-1", "completed");
        const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(engine.events, 2)));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        yield* PubSub.publish(harness.pubsub, {
          id: EventId.make("event-2"),
          threadId: ThreadId.make("thread-1"),
          occurredAt: AT,
          type: "run.updated",
          payload: runFor({
            threadId: ThreadId.make("thread-1"),
            runId: RunId.make("run-1"),
            status: "completed",
            ordinal: 1,
          }),
        } as OrchestrationV2DomainEvent);

        const events = Array.from(yield* Fiber.join(collected)) as Array<PersonalThreadEvent>;
        expect(events.map((event) => event._tag)).toEqual(["StatusChanged", "TurnEnded"]);
        expect(events[1]).toMatchObject({ outcome: { _tag: "Completed" } });
      }),
    );
  });

  it.effect("a failed run carries the thread error and retry marker", () => {
    const harness = makeHarness();
    return withEngine(harness, (engine) =>
      Effect.gen(function* () {
        yield* seedThread(harness);
        yield* seedRun(harness, "thread-1", "run-1", "failed");
        const record = harness.threads.get("thread-1")!;
        record.shell = { ...record.shell, lastError: "rate limited" };
        yield* engine.setProviderRetry({
          threadId: ThreadId.make("thread-1"),
          retry: { auto: "exhausted", attempt: 5, maxAttempts: 5, retryAt: null },
        });

        const collected = yield* Effect.forkChild(Stream.runCollect(Stream.take(engine.events, 2)));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;

        yield* PubSub.publish(harness.pubsub, {
          id: EventId.make("event-3"),
          threadId: ThreadId.make("thread-1"),
          occurredAt: AT,
          type: "run.updated",
          payload: runFor({
            threadId: ThreadId.make("thread-1"),
            runId: RunId.make("run-1"),
            status: "failed",
            ordinal: 1,
          }),
        } as OrchestrationV2DomainEvent);

        const events = Array.from(yield* Fiber.join(collected)) as Array<PersonalThreadEvent>;
        expect(events[1]).toMatchObject({
          _tag: "TurnEnded",
          outcome: {
            _tag: "Failed",
            failure: { message: "rate limited", providerRetry: { kind: "retrying" } },
          },
        });
      }),
    );
  });
});
