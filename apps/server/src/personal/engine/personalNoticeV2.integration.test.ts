import {
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { layerEventSink } from "../../orchestration-v2/runtimeLayer.ts";
import {
  ProjectionStoreV2,
  layer as ProjectionStoreLayer,
} from "../../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { PersonalEngine } from "./PersonalEngine.ts";
import { PersonalEngineV2Live } from "./PersonalEngineV2Live.ts";

const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-test",
};
const THREAD = ThreadId.make("notice-thread");
const AT = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");

const threadEvent: OrchestrationV2DomainEvent = {
  id: "thread-event-1" as never,
  threadId: THREAD,
  occurredAt: AT,
  type: "thread.created",
  payload: {
    createdBy: "system",
    creationSource: "server",
    id: THREAD,
    projectId: ProjectId.make("project-1"),
    title: "Notice thread",
    providerInstanceId: MODEL.instanceId,
    modelSelection: MODEL,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD },
    forkedFrom: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    pullRequests: [],
  },
} as OrchestrationV2DomainEvent;

const threadsLayer = Layer.effect(
  ThreadManagementService.ThreadManagementService,
  Effect.gen(function* () {
    const projection = yield* ProjectionStoreV2;
    return {
      getThreadShell: projection.getThreadShell,
      dispatch: () => Effect.die("unused"),
      getThreadRecords: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      interruptThread: () => Effect.die("unused"),
      streamDomainEvents: Stream.empty,
    } as never;
  }),
);

const projectsLayer = Layer.succeed(ProjectService, {
  create: () => Effect.die("unused"),
  getShell: () => Effect.succeed(Option.none()),
  listShells: () => Effect.succeed([]),
} as never);

const base = Layer.mergeAll(layerEventSink, ProjectionStoreLayer).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const threadsProvided = threadsLayer.pipe(Layer.provideMerge(base));

const testLayer = PersonalEngineV2Live.pipe(
  Layer.provideMerge(threadsProvided),
  Layer.provide(projectsLayer),
);

describe("v2 assistant notice", () => {
  it.effect("writes, reads back and reaches the thread shell with no run", () =>
    Effect.gen(function* () {
      // Message writes need the current schema (search text, item counts).
      yield* runMigrations();
      const projection = yield* ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const engine = yield* PersonalEngine;

      yield* projection.apply(threadEvent);

      yield* engine.postNotice({
        threadId: THREAD,
        messageId: MessageId.make("notice-1"),
        text: "Saved to memory.",
      });

      const messages = yield* engine.listMessages({ threadId: THREAD, limit: 10 });
      expect(
        messages.map((message) => [message.id, message.role, message.text, message.streaming]),
      ).toEqual([["notice-1", "assistant", "Saved to memory.", false]]);

      const records = yield* projection.getThreadRecords(THREAD, ["messages"]);
      expect(records.messages.map((message) => message.id)).toEqual(["notice-1"]);

      const shell = yield* projection.getThreadShell(THREAD);
      expect(shell?.latestVisibleMessage).toBeNull();
      expect(shell?.status).toBe("idle");
      expect(shell?.activeRunId).toBeNull();

      const runs = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS "count" FROM orchestration_v2_events
        WHERE thread_id = ${THREAD} AND event_type LIKE 'run.%'
      `;
      expect(runs[0]?.count).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );
});
