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
  type MessageId,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type TurnId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ThreadBackgroundLivenessService,
  layer as ThreadBackgroundLivenessLive,
} from "../../orchestration/ThreadBackgroundLiveness.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  PersonalEngine,
  type CreateProjectInput,
  type CreateThreadInput,
  type OrchestrationThreadShellV1Wire,
  type PersonalActivityView,
  type PersonalAppendNoticeInput,
  type PersonalCompleteNoticeInput,
  type PersonalContinueTurnInput,
  type PersonalMessageView,
  type PersonalPostNoticeInput,
  type PersonalPostUserMessageInput,
  type PersonalProjectView,
  type PersonalRenameThreadIfUnchangedInput,
  type PersonalSendInput,
  type PersonalSetProviderRetryInput,
  type PersonalSessionView,
  type PersonalStopInput,
  type PersonalThreadEvent,
  type PersonalThreadStatus,
  type PersonalToolStepView,
  type PersonalUpdateMetaInput,
  type PersonalWorkingRow,
} from "./PersonalEngine.ts";
import { failureDetail, PersonalEngineError } from "./errors.ts";

const BUSY_STATUSES: ReadonlySet<PersonalThreadStatus> = new Set(["starting", "running"]);

/** v1 session status to the personal states. */
export const personalStatusOf = (status: OrchestrationSessionStatus): PersonalThreadStatus => {
  switch (status) {
    case "idle":
      return "idle";
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "ready":
      return "waiting";
    case "stopped":
      return "stopped";
    case "interrupted":
      return "interrupted";
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

/** The session as subscribers read it. One shape for every event that carries one. */
export const toPersonalSessionView = (session: OrchestrationSession): PersonalSessionView => ({
  threadId: session.threadId,
  status: personalStatusOf(session.status),
  activeTurnId: session.activeTurnId,
  lastError: session.lastError,
  providerInstanceId: session.providerInstanceId ?? null,
  providerName: session.providerName,
  providerRetry:
    session.providerRetry === undefined
      ? null
      : {
          kind: session.providerRetry.kind,
          provider: session.providerRetry.provider,
          observedAt: session.providerRetry.observedAt,
          ...(session.providerRetry.retryAt === undefined
            ? {}
            : { retryAt: session.providerRetry.retryAt }),
          ...(session.providerRetry.attempt === undefined
            ? {}
            : { attempt: session.providerRetry.attempt }),
          ...(session.providerRetry.maxAttempts === undefined
            ? {}
            : { maxAttempts: session.providerRetry.maxAttempts }),
          ...(session.providerRetry.reason === undefined
            ? {}
            : { reason: session.providerRetry.reason }),
          ...(session.providerRetry.auto === undefined ? {} : { auto: session.providerRetry.auto }),
        },
  updatedAt: session.updatedAt,
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
          interactionMode: event.payload.interactionMode,
        },
      ];
    case "thread.message-sent": {
      const role = event.payload.role;
      if (role !== "user" && role !== "assistant") {
        return [];
      }
      return [
        {
          _tag: "MessageSent",
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          role,
          text: event.payload.text,
          streaming: event.payload.streaming,
        },
      ];
    }
    case "thread.session-set": {
      const { threadId, session } = event.payload;
      const status = personalStatusOf(session.status);
      const previous = statusByThread.get(threadId);
      statusByThread.set(threadId, status);
      const view = toPersonalSessionView(session);
      const events: Array<PersonalThreadEvent> = [
        { _tag: "StatusChanged", threadId, status, session: view },
      ];
      const wasBusy = previous !== undefined && BUSY_STATUSES.has(previous);
      if (wasBusy && session.activeTurnId === null && !BUSY_STATUSES.has(status)) {
        events.push({
          _tag: "TurnEnded",
          threadId,
          outcome:
            status === "error"
              ? { _tag: "Failed", failure: failureOf(session) }
              : status === "waiting"
                ? { _tag: "Completed" }
                : { _tag: "Interrupted" },
          session: view,
        });
      }
      return events;
    }
    case "thread.activity-appended":
      return [
        {
          _tag: "ActivityAppended",
          threadId: event.payload.threadId,
          activity: {
            id: event.payload.activity.id,
            kind: event.payload.activity.kind,
            payload: event.payload.activity.payload,
          },
        },
      ];
    case "thread.turn-interrupt-requested":
    case "thread.session-stop-requested":
      return [{ _tag: "TurnStopRequested", threadId: event.payload.threadId }];
    case "thread.archived":
      return [{ _tag: "ThreadArchived", threadId: event.payload.threadId }];
    case "thread.deleted":
      return [{ _tag: "ThreadDeleted", threadId: event.payload.threadId }];
    default:
      return [];
  }
};

/** The prompt for adapters that cannot continue a turn without one. */
const CONTINUATION_PROMPT = "Continue where you left off.";

const engineError = (operation: string) => (failure: unknown) =>
  new PersonalEngineError({ operation, detail: failureDetail(failure) });

const toProjectView = (shell: {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}): PersonalProjectView => ({ id: shell.id, workspaceRoot: shell.workspaceRoot });

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

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const messages = yield* ProjectionThreadMessageRepository;
  const liveness = yield* ThreadBackgroundLivenessService;
  // Optional so the read and write verbs stay testable alone; only
  // `continueTurn` needs it, and the server always provides it.
  const providerService = yield* Effect.serviceOption(ProviderService);
  const sql = yield* SqlClient.SqlClient;
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
      // A missing shell is not a refusal: the v1 decider owns that check,
      // and the callers that had no shell read used these same defaults.
      const shell = yield* snapshots.getThreadShellById(input.threadId);
      const thread = Option.getOrUndefined(shell);
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
        runtimeMode: thread?.runtimeMode ?? "full-access",
        interactionMode: thread?.interactionMode ?? "default",
        ...(input.mode === "start" ? {} : { followUp: input.mode }),
        createdAt: yield* now,
      });
    }).pipe(Effect.mapError(engineError("send")));

  const interrupt = (
    threadId: ThreadId,
    turnId?: TurnId,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`personal-engine:turn.interrupt:${NodeCrypto.randomUUID()}`),
        threadId,
        ...(turnId === undefined ? {} : { turnId }),
        createdAt: yield* now,
      });
    }).pipe(Effect.mapError(engineError("interrupt")));

  const continueTurn = (
    input: PersonalContinueTurnInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const shell = Option.getOrUndefined(yield* snapshots.getThreadShellById(input.threadId));
      const instanceId = shell?.session?.providerInstanceId;
      if (Option.isNone(providerService)) {
        return yield* new PersonalEngineError({
          operation: "continueTurn",
          detail: "no provider service is wired into this engine",
        });
      }
      if (instanceId === undefined) {
        return yield* new PersonalEngineError({
          operation: "continueTurn",
          detail: "the session has no provider instance to continue on",
        });
      }
      const capabilities = yield* providerService.value.getCapabilities(instanceId);
      yield* providerService.value.sendTurn({
        threadId: input.threadId,
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(capabilities.promptlessTurnContinuation === true
          ? { continuation: true }
          : { input: CONTINUATION_PROMPT }),
        interactionMode: input.interactionMode,
        ...(input.systemInstructions !== undefined
          ? { systemInstructions: input.systemInstructions }
          : {}),
      });
    }).pipe(Effect.mapError(engineError("continueTurn")));

  const setProviderRetry = (
    input: PersonalSetProviderRetryInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const shell = Option.getOrUndefined(yield* snapshots.getThreadShellById(input.threadId));
      const session = shell?.session;
      if (session == null) return;
      const at = yield* now;
      if (input.retry === null) {
        if (session.providerRetry?.auto === undefined) return;
        const rest: OrchestrationSession = { ...session };
        delete (rest as { providerRetry?: unknown }).providerRetry;
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`personal-turn-retry-clear:${NodeCrypto.randomUUID()}`),
          threadId: input.threadId,
          session: { ...rest, updatedAt: at },
          createdAt: at,
        });
        return;
      }
      const { auto, attempt, maxAttempts, retryAt } = input.retry;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`personal-turn-retry:${NodeCrypto.randomUUID()}`),
        threadId: input.threadId,
        session: {
          ...session,
          providerRetry: {
            kind: "retrying",
            attempt,
            maxAttempts,
            ...(retryAt === null ? {} : { retryAt }),
            auto,
            provider: session.providerName ?? "provider",
            observedAt: at,
          },
          updatedAt: at,
        },
        createdAt: at,
      });
    }).pipe(Effect.mapError(engineError("setProviderRetry")));

  const stop = (input: PersonalStopInput): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.session.stop",
        // A chat can be stopped again after a later turn starts, so the id is
        // per call, not per thread.
        commandId: CommandId.make(`personal-engine:session.stop:${NodeCrypto.randomUUID()}`),
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

  const renameThreadIfUnchanged = (
    input: PersonalRenameThreadIfUnchangedInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.title.generate.complete",
        commandId: CommandId.make(`personal-engine:thread.title:${NodeCrypto.randomUUID()}`),
        threadId: input.threadId,
        title: input.title,
        expectedTitle: input.expectedTitle,
        expectedVersion: input.expectedVersion,
        needsRefinement: false,
      });
    }).pipe(Effect.mapError(engineError("renameThreadIfUnchanged")));

  const appendNotice = (
    input: PersonalAppendNoticeInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make(`personal-engine:notice.delta:${input.messageId}:${input.key}`),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: input.delta,
        ...(input.context === undefined ? {} : { context: input.context }),
        createdAt: yield* now,
      });
    }).pipe(Effect.mapError(engineError("appendNotice")));

  const completeNotice = (
    input: PersonalCompleteNoticeInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`personal-engine:notice.complete:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        createdAt: yield* now,
      });
    }).pipe(Effect.mapError(engineError("completeNotice")));

  const postUserMessage = (
    input: PersonalPostUserMessageInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make(`personal-engine:message.user:${input.messageId}`),
        threadId: input.threadId,
        message: {
          messageId: input.messageId,
          text: input.text,
          attachments: [],
          ...(input.context === undefined ? {} : { context: input.context }),
        },
        createdAt: yield* now,
      });
    }).pipe(Effect.mapError(engineError("postUserMessage")));

  const postNotice = (input: PersonalPostNoticeInput): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      // Both commands write one message. An interruption between them would
      // leave the notice streaming forever.
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* appendNotice({
            threadId: input.threadId,
            messageId: input.messageId,
            delta: input.text,
            key: "notice",
            ...(input.context === undefined ? {} : { context: input.context }),
          });
          yield* completeNotice({
            threadId: input.threadId,
            messageId: input.messageId,
          });
        }),
      );
    }).pipe(Effect.mapError(engineError("postNotice")));

  const getThread = (threadId: ThreadId) =>
    snapshots.getThreadShellById(threadId).pipe(Effect.mapError(engineError("getThread")));

  const getProject = (projectId: ProjectId) =>
    snapshots
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.map(toProjectView)), Effect.mapError(engineError("getProject")));

  const listProjects = () =>
    snapshots.getProjectShells().pipe(
      Effect.map((shells) => shells.map(toProjectView)),
      Effect.mapError(engineError("listProjects")),
    );

  const listForThread = (threadId: ThreadId) =>
    messages.listByThreadId({ threadId }).pipe(Effect.mapError(engineError("listMessages")));

  const latestAssistantMessage = (input: {
    readonly threadId: ThreadId;
    readonly after?: DateTime.Utc;
    readonly afterMessageId?: MessageId;
    readonly turnId?: TurnId;
  }): Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError> =>
    Effect.gen(function* () {
      if (input.turnId !== undefined) {
        const found = yield* messages.getLatestAssistantMessageForTurn({
          threadId: input.threadId,
          turnId: input.turnId,
        });
        return Option.map(found, toMessageView);
      }
      if (input.after !== undefined && input.afterMessageId !== undefined) {
        const found = yield* messages.getLatestAssistantMessageAfter({
          threadId: input.threadId,
          afterCreatedAt: DateTime.formatIso(input.after),
          afterMessageId: input.afterMessageId,
        });
        return Option.map(found, toMessageView);
      }
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
    }).pipe(Effect.mapError(engineError("latestAssistantMessage")));

  const latestUserMessage = (input: {
    readonly threadId: ThreadId;
    readonly excludeIdPrefix?: string;
  }): Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError> =>
    Effect.gen(function* () {
      const rows = yield* listForThread(input.threadId);
      const found = rows
        .filter(
          (row) =>
            row.role === "user" &&
            (input.excludeIdPrefix === undefined ||
              !row.messageId.startsWith(input.excludeIdPrefix)),
        )
        .at(-1);
      return found === undefined ? Option.none() : Option.some(toMessageView(found));
    }).pipe(Effect.mapError(engineError("latestUserMessage")));

  const messageById = (
    messageId: MessageId,
  ): Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError> =>
    messages.getByMessageId({ messageId }).pipe(
      Effect.map((found) => Option.map(found, toMessageView)),
      Effect.mapError(engineError("messageById")),
    );

  const messagesByIds = (input: {
    readonly threadId: ThreadId;
    readonly messageIds: ReadonlyArray<MessageId>;
  }): Effect.Effect<ReadonlyArray<PersonalMessageView>, PersonalEngineError> =>
    Effect.gen(function* () {
      if (input.messageIds.length === 0) return [];
      const wanted = new Set(input.messageIds);
      const rows = yield* listForThread(input.threadId);
      return rows.filter((row) => wanted.has(row.messageId)).map(toMessageView);
    }).pipe(Effect.mapError(engineError("messagesByIds")));

  const listMessages = (input: {
    readonly threadId: ThreadId;
    readonly limit: number;
    readonly before?: DateTime.Utc;
  }): Effect.Effect<ReadonlyArray<PersonalMessageView>, PersonalEngineError> =>
    Effect.gen(function* () {
      if (input.limit <= 0) return [];
      const rows = yield* listForThread(input.threadId);
      const beforeMillis = input.before === undefined ? null : DateTime.toEpochMillis(input.before);
      const filtered =
        beforeMillis === null ? rows : rows.filter((row) => atMillis(row.createdAt) < beforeMillis);
      return filtered.slice(-input.limit).map(toMessageView);
    });

  const latestContextTokens = (
    threadId: ThreadId,
  ): Effect.Effect<number | null, PersonalEngineError> =>
    sql<{ readonly used: number | null }>`
      SELECT json_extract(payload_json, '$.usedTokens') AS "used"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId} AND kind = 'context-window.updated'
      ORDER BY created_at DESC LIMIT 1
    `.pipe(
      Effect.map((rows) => (typeof rows[0]?.used === "number" ? rows[0].used : null)),
      Effect.orElseSucceed(() => null),
      Effect.mapError(engineError("latestContextTokens")),
    );

  const compactedSince = (input: {
    readonly threadId: ThreadId;
    readonly since: string;
  }): Effect.Effect<boolean, PersonalEngineError> =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS "count" FROM projection_thread_activities
      WHERE thread_id = ${input.threadId} AND kind = 'context-compaction' AND created_at > ${input.since}
    `.pipe(
      Effect.map((rows) => (rows[0]?.count ?? 0) > 0),
      Effect.orElseSucceed(() => true),
      Effect.mapError(engineError("compactedSince")),
    );

  const threadUsedWeb = (input: {
    readonly threadId: ThreadId;
    readonly needles: ReadonlyArray<string>;
  }): Effect.Effect<boolean, PersonalEngineError> =>
    input.needles.length === 0
      ? Effect.succeed(false)
      : sql<{ readonly found: number }>`
          SELECT 1 AS "found"
          FROM projection_thread_activities a
          WHERE a.thread_id = ${input.threadId} AND a.kind LIKE 'tool.%'
            AND (
              json_extract(a.payload_json, '$.itemType') = 'web_search'
              OR ${sql.or(
                input.needles.map(
                  (needle) =>
                    sql`instr(lower(a.summary || ' ' || COALESCE(json_extract(a.payload_json, '$.title'), '') || ' ' || substr(COALESCE(json_extract(a.payload_json, '$.detail'), ''), 1, 80)), ${needle}) > 0`,
                ),
              )}
            )
          LIMIT 1
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.mapError(engineError("threadUsedWeb")),
        );

  const toolStepsSince = (input: {
    readonly threadId: ThreadId;
    readonly since: string;
    readonly limit: number;
  }): Effect.Effect<ReadonlyArray<PersonalToolStepView>, PersonalEngineError> => {
    if (input.limit <= 0) return Effect.succeed([]);
    return sql<{
      readonly id: string;
      readonly itemType: string | null;
      readonly text: string;
    }>`
      SELECT activity_id AS "id",
        json_extract(a.payload_json, '$.itemType') AS "itemType",
        a.summary || ' ' || COALESCE(json_extract(a.payload_json, '$.title'), '') || ' '
          || substr(COALESCE(json_extract(a.payload_json, '$.detail'), ''), 1, 80) AS "text"
      FROM projection_thread_activities a
      WHERE a.thread_id = ${input.threadId} AND a.kind LIKE 'tool.%'
        AND a.created_at >= ${input.since}
      LIMIT ${input.limit}
    `.pipe(Effect.mapError(engineError("toolStepsSince")));
  };

  const activitiesByIds = (input: {
    readonly threadId: ThreadId;
    readonly ids: ReadonlyArray<string>;
  }): Effect.Effect<ReadonlyArray<PersonalActivityView>, PersonalEngineError> => {
    if (input.ids.length === 0) return Effect.succeed([]);
    return sql<{
      readonly id: string;
      readonly kind: string;
      readonly payloadJson: string;
    }>`
      SELECT activity_id AS "id", kind, payload_json AS "payloadJson"
      FROM projection_thread_activities
      WHERE thread_id = ${input.threadId} AND ${sql.in("activity_id", input.ids)}
    `.pipe(
      Effect.map((rows) =>
        rows.flatMap((row) => {
          try {
            return [{ id: row.id, kind: row.kind, payload: JSON.parse(row.payloadJson) }];
          } catch {
            return [];
          }
        }),
      ),
      Effect.mapError(engineError("activitiesByIds")),
    );
  };

  const workingSnapshot = (
    threadIds: ReadonlyArray<ThreadId>,
  ): Effect.Effect<ReadonlyArray<PersonalWorkingRow>, PersonalEngineError> => {
    if (threadIds.length === 0) return Effect.succeed([]);
    return sql<PersonalWorkingRow>`
      SELECT
        p.thread_id AS "threadId",
        p.latest_turn_id AS "turnId",
        (
          SELECT substr(m.text, 1, 400) FROM projection_thread_messages m
          WHERE m.thread_id = p.thread_id AND m.role = 'reasoning'
            AND m.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY m.updated_at DESC, m.message_id DESC LIMIT 1
        ) AS "reasoningText",
        (
          SELECT m.updated_at FROM projection_thread_messages m
          WHERE m.thread_id = p.thread_id AND m.role = 'reasoning'
            AND m.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY m.updated_at DESC, m.message_id DESC LIMIT 1
        ) AS "reasoningAt",
        (
          SELECT NULLIF(json_extract(a.payload_json, '$.title'), '')
          FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolTitle",
        (
          SELECT a.summary FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolSummary",
        (
          SELECT a.created_at FROM projection_thread_activities a
          WHERE a.thread_id = p.thread_id AND a.kind LIKE 'tool.%'
            AND a.created_at >= MAX(COALESCE(p.latest_user_message_at, ''), COALESCE(t.requested_at, ''))
          ORDER BY a.created_at DESC, a.sequence DESC LIMIT 1
        ) AS "toolAt"
      FROM projection_threads p
      LEFT JOIN projection_turns t
        ON t.thread_id = p.thread_id AND t.turn_id = p.latest_turn_id
      JOIN projection_thread_sessions s ON s.thread_id = p.thread_id
      WHERE ${sql.in("p.thread_id", threadIds)}
        AND p.deleted_at IS NULL
        AND s.status IN ('running', 'starting')
    `.pipe(Effect.mapError(engineError("workingSnapshot")));
  };

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
    continueTurn,
    setProviderRetry,
    interrupt,
    stop,
    archive,
    deleteThread,
    updateMeta,
    renameThreadIfUnchanged,
    postNotice,
    appendNotice,
    completeNotice,
    postUserMessage,
    getThread,
    getProject,
    listProjects,
    latestAssistantMessage,
    latestUserMessage,
    messageById,
    messagesByIds,
    listMessages,
    latestContextTokens,
    compactedSince,
    threadUsedWeb,
    toolStepsSince,
    activitiesByIds,
    workingSnapshot,
    liveTaskIds,
    shellSnapshot,
    events,
  });
});

/** The engine over the v1 surface; every read service comes from the caller. */
export const PersonalEngineV1Live = Layer.effect(PersonalEngine, make);

/**
 * The layer consumers use: the v1 read adapters come with it, so a chain
 * provides only the orchestrator engine and the snapshot query it already has.
 */
export const PersonalEngineV1WiredLive = PersonalEngineV1Live.pipe(
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(ThreadBackgroundLivenessLive),
);
