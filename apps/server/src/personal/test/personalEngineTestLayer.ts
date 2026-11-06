/**
 * An in-memory v2 thread engine for personal service tests.
 *
 * Applies the thread commands the personal layer sends to the v2 projection
 * tables, and mirrors the same rows into the v1 projection tables that the
 * personal repository still reads through its relations. No orchestrator, no
 * provider; enough state for the personal services to behave as they do live.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ProjectService } from "../../project/ProjectService.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import {
  ProjectionStoreV2,
  layer as ProjectionStoreLayer,
} from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { PersonalEngineV2Live } from "../engine/PersonalEngineV2Live.ts";
import { PersonalProjectionRelations } from "../engine/PersonalProjectionRelations.ts";
import { PERSONAL_V1_RELATIONS } from "../engine/PersonalProjectionRelationsV1Live.ts";

export const TEST_PROJECT_ID = ProjectId.make("personal-test-project");

export interface PersonalEngineHarness {
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
}

export const makePersonalEngineHarness = (): PersonalEngineHarness => ({ dispatched: [] });

const nowIso = () => DateTime.formatIso(DateTime.makeUnsafe(Date.now()));

const threadPayload = (thread: OrchestrationV2AppThread) => JSON.stringify(thread);

const baseThread = (
  command: Extract<OrchestrationV2ServerCommand, { type: "thread.create" }>,
  at: string,
): OrchestrationV2AppThread =>
  ({
    createdBy: command.createdBy ?? "system",
    creationSource: command.creationSource ?? "server",
    id: command.threadId,
    projectId: command.projectId,
    title: command.title,
    providerInstanceId: command.modelSelection.instanceId,
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: command.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: command.branch ?? null,
    worktreePath: command.worktreePath ?? null,
    pullRequests: [],
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: command.threadId,
    },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  }) as unknown as OrchestrationV2AppThread;

/** The v1 projection row the personal repository queries. */
const insertV1Thread = (sql: SqlClient.SqlClient, thread: OrchestrationV2AppThread) =>
  sql`
    INSERT OR REPLACE INTO projection_threads
      (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        branch, worktree_path, created_at, updated_at, archived_at, deleted_at)
    VALUES (${thread.id}, ${thread.projectId}, ${thread.title}, ${JSON.stringify(thread.modelSelection)},
      ${thread.runtimeMode}, ${thread.interactionMode}, ${thread.branch}, ${thread.worktreePath},
      ${thread.createdAt as never}, ${thread.updatedAt as never},
      ${thread.archivedAt === null ? null : (thread.archivedAt as never)},
      ${thread.deletedAt === null ? null : (thread.deletedAt as never)})
  `;

const applyCommand = (harness: PersonalEngineHarness, command: OrchestrationV2ServerCommand) =>
  Effect.gen(function* () {
    harness.dispatched.push(command);
    const sql = yield* SqlClient.SqlClient;
    if (command.type === "thread.create") {
      const thread = baseThread(command, nowIso());
      yield* sql`
        INSERT OR REPLACE INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
        VALUES (${thread.id}, ${thread.projectId}, ${thread.title}, ${thread.providerInstanceId},
          ${thread.runtimeMode}, ${thread.interactionMode}, NULL,
          ${thread.createdAt as never}, ${thread.updatedAt as never},
          NULL, NULL, ${threadPayload(thread)})
      `;
      yield* insertV1Thread(sql, thread);
      return { sequence: harness.dispatched.length } as never;
    }
    if (command.type === "thread.metadata.update" && command.title !== undefined) {
      const at = nowIso();
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET title = ${command.title},
          updated_at = ${at},
          payload_json = json_set(payload_json, '$.title', ${command.title}, '$.updatedAt', ${at})
        WHERE thread_id = ${command.threadId}
      `;
      yield* sql`
        UPDATE projection_threads SET title = ${command.title}, updated_at = ${at}
        WHERE thread_id = ${command.threadId}
      `;
      return { sequence: harness.dispatched.length } as never;
    }
    if (command.type === "message.dispatch") {
      const at = nowIso();
      const existing = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM orchestration_v2_projection_messages
        WHERE thread_id = ${command.threadId}
      `;
      const count = Number(existing[0]?.count ?? 0);
      const runId = RunId.make(`run-${command.messageId}`);
      const message = {
        createdBy: command.createdBy ?? "user",
        creationSource: command.creationSource ?? "server",
        id: command.messageId,
        threadId: command.threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: command.text,
        attachments: command.attachments ?? [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      };
      yield* sql`
        INSERT OR REPLACE INTO orchestration_v2_projection_messages
          (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
        VALUES (${command.messageId}, ${command.threadId}, NULL, NULL, 'user', 0, ${at}, ${at},
          ${JSON.stringify(message)})
      `;
      yield* sql`
        INSERT OR REPLACE INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${command.messageId}, ${command.threadId}, NULL, 'user', ${command.text}, 0, ${at}, ${at})
      `;
      yield* sql`
        INSERT OR REPLACE INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at,
            completed_at, payload_json)
        VALUES (${runId}, ${command.threadId}, ${count + 1}, 'claudeAgent', NULL, 'running', ${at},
          NULL, ${JSON.stringify({ userMessageId: command.messageId })})
      `;
      if (command.titleSeed !== undefined && count === 0) {
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET title = ${command.titleSeed},
            payload_json = json_set(payload_json, '$.title', ${command.titleSeed})
          WHERE thread_id = ${command.threadId}
        `;
        yield* sql`
          UPDATE projection_threads SET title = ${command.titleSeed}
          WHERE thread_id = ${command.threadId}
        `;
      }
      return { sequence: harness.dispatched.length } as never;
    }
    if (command.type === "thread.archive" || command.type === "thread.unarchive") {
      const at = command.type === "thread.archive" ? nowIso() : null;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET archived_at = ${at},
          payload_json = json_set(payload_json, '$.archivedAt', ${at})
        WHERE thread_id = ${command.threadId}
      `;
      yield* sql`
        UPDATE projection_threads SET archived_at = ${at} WHERE thread_id = ${command.threadId}
      `;
      return { sequence: harness.dispatched.length } as never;
    }
    if (command.type === "thread.delete") {
      const at = nowIso();
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET deleted_at = ${at},
          payload_json = json_set(payload_json, '$.deletedAt', ${at})
        WHERE thread_id = ${command.threadId}
      `;
      yield* sql`
        UPDATE projection_threads SET deleted_at = ${at} WHERE thread_id = ${command.threadId}
      `;
      return { sequence: harness.dispatched.length } as never;
    }
    if (command.type === "thread.model-selection.set") {
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.modelSelection', json(${JSON.stringify(command.modelSelection)}))
        WHERE thread_id = ${command.threadId}
      `;
      return { sequence: harness.dispatched.length } as never;
    }
    if (command.type === "thread.stop" || command.type === "run.interrupt") {
      const at = nowIso();
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'interrupted', completed_at = ${at}
        WHERE thread_id = ${command.threadId}
          AND status IN ('preparing', 'starting', 'running', 'waiting')
      `;
      return { sequence: harness.dispatched.length } as never;
    }
    return { sequence: harness.dispatched.length } as never;
  });

const threadsLayer = (harness: PersonalEngineHarness) =>
  Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const projection = yield* ProjectionStoreV2;
      return {
        dispatch: (command: OrchestrationV2ServerCommand) => applyCommand(harness, command),
        getThreadShell: projection.getThreadShell,
        getThreadRecords: projection.getThreadRecords,
        getShellSnapshot: projection.getShellSnapshot,
        getMessageCount: projection.getMessageCount,
        getThreadProjection: projection.getThreadProjection,
        getThreadSnapshot: projection.getThreadSnapshot,
        listProjectThreads: () => Effect.succeed([]),
        searchThread: () => Effect.die("unused in personal engine tests"),
        streamDomainEvents: Stream.empty,
        interruptThread: () => Effect.die("unused in personal engine tests"),
      } as never;
    }),
  ).pipe(Layer.provide(ProjectionStoreLayer));

const projectsLayer = Layer.succeed(ProjectService, {
  create: () => Effect.void,
  getShell: () =>
    Effect.succeed(
      Option.some({
        id: TEST_PROJECT_ID,
        title: "Personal",
        workspaceRoot: process.cwd(),
      } as never),
    ),
  listShells: () => Effect.succeed([]),
} as never);

const eventSinkLayer = Layer.succeed(EventSinkV2, {
  write: () => Effect.succeed([]),
} as never);

/** PersonalEngine with a fake v2 thread engine over the test database. */
export const personalEngineTestLayer = (harness: PersonalEngineHarness) =>
  PersonalEngineV2Live.pipe(
    Layer.provide(threadsLayer(harness)),
    Layer.provide(projectsLayer),
    Layer.provide(eventSinkLayer),
    Layer.provideMerge(Layer.succeed(PersonalProjectionRelations, PERSONAL_V1_RELATIONS)),
  );

export const commandId = (value: string) => CommandId.make(value);
export const messageId = (value: string) => MessageId.make(value);
export const threadId = (value: string) => ThreadId.make(value);
