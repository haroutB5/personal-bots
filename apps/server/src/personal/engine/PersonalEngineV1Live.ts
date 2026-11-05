/**
 * PersonalEngine on the v1 orchestrator.
 *
 * Wraps OrchestrationEngine for writes, ProjectionSnapshotQuery for thread
 * reads, ProjectionThreadMessageRepository for message reads and
 * ThreadBackgroundLivenessService for live task ids. No caller moves yet.
 *
 * @module personal/engine/PersonalEngineV1Live
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../../orchestration/ThreadBackgroundLiveness.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  PersonalEngine,
  type CreateProjectInput,
  type CreateThreadInput,
  type OrchestrationThreadShellV1Wire,
  type PersonalMessageView,
  type PersonalPostNoticeInput,
  type PersonalSendInput,
  type PersonalStopInput,
  type PersonalThreadEvent,
  type PersonalThreadStatus,
  type PersonalUpdateMetaInput,
} from "./PersonalEngine.ts";
import { failureDetail, PersonalEngineError } from "./errors.ts";

const BUSY_STATUSES: ReadonlySet<PersonalThreadStatus> = new Set(["starting", "running"]);

/** v1 session status to the five personal states. */
export const personalStatusOf = (status: OrchestrationSessionStatus): PersonalThreadStatus => {
  switch (status) {
    case "idle":
    case "stopped":
    case "interrupted":
      return "idle";
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "ready":
      return "waiting";
    case "error":
      return "error";
  }
};

const failureOf = (
  session: OrchestrationSession,
): {
  readonly message: string | null;
  readonly providerRetry: {
    readonly kind: "rate_limited" | "retrying";
    readonly retryAt: string | null;
  } | null;
} => ({
  message: session.lastError,
  providerRetry:
    session.providerRetry === undefined
      ? null
      : { kind: session.providerRetry.kind, retryAt: session.providerRetry.retryAt ?? null },
});

/**
 * One v1 event becomes zero, one or two personal events. `statusByThread`
 * carries the previous status so a turn end is a busy-to-rest transition, not
 * every idle session-set. v1 ends a turn at running -> ready with no active
 * turn; error ends it failed, idle or stopped ends it interrupted.
 */
export const toPersonalEvents = (
  event: OrchestrationEvent,
  statusByThread: Map<string, PersonalThreadStatus>,
): ReadonlyArray<PersonalThreadEvent> => {
  switch (event.type) {
    case "thread.turn-start-requested":
      return [
        {
          _tag: "TurnStartRequested",
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
        },
      ];
    case "thread.message-sent": {
      const role = event.payload.role;
      if (event.payload.streaming || (role !== "user" && role !== "assistant")) {
        return [];
      }
      return [
        {
          _tag: "MessageSent",
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          role,
        },
      ];
    }
    case "thread.session-set": {
      const { threadId, session } = event.payload;
      const status = personalStatusOf(session.status);
      const previous = statusByThread.get(threadId);
      statusByThread.set(threadId, status);
      const events: Array<PersonalThreadEvent> = [{ _tag: "StatusChanged", threadId, status }];
      const wasBusy = previous !== undefined && BUSY_STATUSES.has(previous);
      if (wasBusy && session.activeTurnId === null && !BUSY_STATUSES.has(status)) {
        events.push({
          _tag: "TurnEnded",
          threadId,
          outcome:
            status === "error"
              ? { _tag: "Failed", failure: failureOf(session) }
              : status === "idle"
                ? { _tag: "Interrupted" }
                : { _tag: "Completed" },
        });
      }
      return events;
    }
    case "thread.archived":
      return [{ _tag: "ThreadArchived", threadId: event.payload.threadId }];
    case "thread.deleted":
      return [{ _tag: "ThreadDeleted", threadId: event.payload.threadId }];
    default:
      return [];
  }
};

const engineError = (operation: string) => (failure: unknown) =>
  new PersonalEngineError({ operation, detail: failureDetail(failure) });

const toMessageView = (row: ProjectionThreadMessage): PersonalMessageView => ({
  id: row.messageId,
  role: row.role,
  text: row.text,
  ...(row.attachments === undefined ? {} : { attachments: row.attachments }),
  ...(row.context === undefined ? {} : { context: row.context }),
  turnId: row.turnId,
  streaming: row.isStreaming,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const atMillis = (iso: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

export const PersonalEngineV1Live = Layer.effect(
  PersonalEngine,
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    const messages = yield* ProjectionThreadMessageRepository;
    const liveness = yield* ThreadBackgroundLivenessService;
    const statusByThread = new Map<string, PersonalThreadStatus>();

    const now = Effect.map(DateTime.now, DateTime.formatIso);

    const createProject = (
      input: CreateProjectInput,
    ): Effect.Effect<ProjectId, PersonalEngineError> =>
      Effect.gen(function* () {
        const projectId = input.projectId ?? ProjectId.make(NodeCrypto.randomUUID());
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`personal-engine:project.create:${projectId}`),
          projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          ...(input.createWorkspaceRootIfMissing === undefined
            ? {}
            : { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }),
          createdAt: yield* now,
        });
        return projectId;
      }).pipe(Effect.mapError(engineError("createProject")));

    const createThread = (input: CreateThreadInput): Effect.Effect<ThreadId, PersonalEngineError> =>
      Effect.gen(function* () {
        const threadId = input.threadId ?? ThreadId.make(NodeCrypto.randomUUID());
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`personal-engine:thread.create:${threadId}`),
          threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: input.branch ?? null,
          worktreePath: input.worktreePath ?? null,
          createdAt: yield* now,
        });
        return threadId;
      }).pipe(Effect.mapError(engineError("createThread")));

    const send = (input: PersonalSendInput): Effect.Effect<void, PersonalEngineError> =>
      Effect.gen(function* () {
        const shell = yield* snapshots.getThreadShellById(input.threadId);
        if (Option.isNone(shell)) {
          return yield* Effect.fail(
            new PersonalEngineError({
              operation: "send",
              detail: `thread ${input.threadId} does not exist`,
            }),
          );
        }
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`personal-engine:turn.start:${input.messageId}`),
          threadId: input.threadId,
          message: {
            messageId: input.messageId,
            role: "user",
            text: input.text,
            attachments: input.attachments,
            ...(input.context === undefined ? {} : { context: input.context }),
          },
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          ...(input.titleSeed === undefined ? {} : { titleSeed: input.titleSeed }),
          runtimeMode: shell.value.runtimeMode,
          interactionMode: shell.value.interactionMode,
          ...(input.mode === "start" ? {} : { followUp: input.mode }),
          createdAt: yield* now,
        });
      }).pipe(Effect.mapError(engineError("send")));

    const interrupt = (threadId: ThreadId): Effect.Effect<void, PersonalEngineError> =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`personal-engine:turn.interrupt:${NodeCrypto.randomUUID()}`),
          threadId,
          createdAt: yield* now,
        });
      }).pipe(Effect.mapError(engineError("interrupt")));

    const stop = (input: PersonalStopInput): Effect.Effect<void, PersonalEngineError> =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`personal-engine:session.stop:${input.threadId}`),
          threadId: input.threadId,
          terminateProcesses: input.terminateProcesses,
          createdAt: yield* now,
        });
      }).pipe(Effect.mapError(engineError("stop")));

    const archive = (threadId: ThreadId): Effect.Effect<void, PersonalEngineError> =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`personal-engine:thread.archive:${threadId}`),
          threadId,
        });
      }).pipe(Effect.mapError(engineError("archive")));

    const deleteThread = (threadId: ThreadId): Effect.Effect<void, PersonalEngineError> =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`personal-engine:thread.delete:${threadId}`),
          threadId,
        });
      }).pipe(Effect.mapError(engineError("deleteThread")));

    const updateMeta = (input: PersonalUpdateMetaInput): Effect.Effect<void, PersonalEngineError> =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`personal-engine:thread.meta:${NodeCrypto.randomUUID()}`),
          threadId: input.threadId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
        });
      }).pipe(Effect.mapError(engineError("updateMeta")));

    const postNotice = (input: PersonalPostNoticeInput): Effect.Effect<void, PersonalEngineError> =>
      Effect.gen(function* () {
        const createdAt = yield* now;
        // Both commands write one message. An interruption between them would
        // leave the notice streaming forever.
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* engine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: CommandId.make(`personal-engine:notice.delta:${input.messageId}`),
              threadId: input.threadId,
              messageId: input.messageId,
              delta: input.text,
              createdAt,
            });
            yield* engine.dispatch({
              type: "thread.message.assistant.complete",
              commandId: CommandId.make(`personal-engine:notice.complete:${input.messageId}`),
              threadId: input.threadId,
              messageId: input.messageId,
              createdAt,
            });
          }),
        );
      }).pipe(Effect.mapError(engineError("postNotice")));

    const getThread = (threadId: ThreadId) =>
      snapshots.getThreadShellById(threadId).pipe(Effect.mapError(engineError("getThread")));

    const listForThread = (threadId: ThreadId) =>
      messages.listByThreadId({ threadId }).pipe(Effect.mapError(engineError("listMessages")));

    const latestAssistantMessage = (input: {
      readonly threadId: ThreadId;
      readonly after?: DateTime.Utc;
    }): Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError> =>
      Effect.gen(function* () {
        const rows = yield* listForThread(input.threadId);
        const afterMillis = input.after === undefined ? null : DateTime.toEpochMillis(input.after);
        const found = rows
          .filter(
            (row) =>
              row.role === "assistant" &&
              (afterMillis === null || atMillis(row.createdAt) > afterMillis),
          )
          .at(-1);
        return found === undefined ? Option.none() : Option.some(toMessageView(found));
      });

    const listMessages = (input: {
      readonly threadId: ThreadId;
      readonly limit: number;
      readonly before?: DateTime.Utc;
    }): Effect.Effect<ReadonlyArray<PersonalMessageView>, PersonalEngineError> =>
      Effect.gen(function* () {
        if (input.limit <= 0) return [];
        const rows = yield* listForThread(input.threadId);
        const beforeMillis =
          input.before === undefined ? null : DateTime.toEpochMillis(input.before);
        const filtered =
          beforeMillis === null
            ? rows
            : rows.filter((row) => atMillis(row.createdAt) < beforeMillis);
        return filtered.slice(-input.limit).map(toMessageView);
      });

    const liveTaskIds = (
      threadId: ThreadId,
    ): Effect.Effect<ReadonlyArray<string>, PersonalEngineError> =>
      Effect.sync(() => liveness.getThreadLiveTaskIds(threadId));

    const shellSnapshot = (input: {
      readonly unsettledOnly: boolean;
    }): Effect.Effect<ReadonlyArray<OrchestrationThreadShellV1Wire>, PersonalEngineError> =>
      snapshots.getShellSnapshot({ unsettledOnly: input.unsettledOnly }).pipe(
        Effect.map((snapshot) => snapshot.threads as ReadonlyArray<OrchestrationThreadShellV1Wire>),
        Effect.mapError(engineError("shellSnapshot")),
      );

    const events = engine.streamDomainEvents.pipe(
      Stream.flatMap((event) => Stream.fromIterable(toPersonalEvents(event, statusByThread))),
    );

    return PersonalEngine.of({
      createProject,
      createThread,
      send,
      interrupt,
      stop,
      archive,
      deleteThread,
      updateMeta,
      postNotice,
      getThread,
      latestAssistantMessage,
      listMessages,
      liveTaskIds,
      shellSnapshot,
      events,
    });
  }),
);
