/**
 * PersonalEngine on the upstream v2 orchestrator.
 *
 * Wraps ThreadManagementService for thread verbs, ProjectService for projects,
 * ProjectionStoreV2 for shell reads and the personal retry table, and
 * OrchestratorV2 domain events for the personal event stream. Notices and
 * message reads land in C2, the v1 wire shim in C3.
 *
 * @module personal/engine/PersonalEngineV2Live
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type OrchestrationSession,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ProjectService } from "../../project/ProjectService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { PersonalProviderSessions } from "./PersonalProviderSessions.ts";
import {
  PersonalEngine,
  type CreateProjectInput,
  type CreateThreadInput,
  type OrchestrationThreadShellV1Wire,
  type PersonalActivityView,
  type PersonalAppendNoticeInput,
  type PersonalCompleteNoticeInput,
  type PersonalContinueTurnInput,
  type PersonalEngineShape,
  type PersonalMessageView,
  type PersonalPostNoticeInput,
  type PersonalPostUserMessageInput,
  type PersonalProjectView,
  type PersonalProviderRetryView,
  type PersonalRenameThreadIfUnchangedInput,
  type PersonalSendInput,
  type PersonalSessionView,
  type PersonalSetProviderRetryInput,
  type PersonalStopInput,
  type PersonalThreadView,
  type PersonalToolStepView,
  type PersonalUpdateMetaInput,
  type PersonalWorkingRow,
} from "./PersonalEngine.ts";
import { failureDetail, PersonalEngineError } from "./errors.ts";
import {
  PERSONAL_TITLE_SEED_COMMAND_TAG,
  personalTitleSeedForSend,
} from "../personalThreadTitles.ts";
import { isFreshTaskTurn } from "../sessionHandoff.ts";
import {
  makePersonalEventState,
  toPersonalEvents,
  type PersonalEventContext,
} from "./personalThreadEventsV2.ts";
import {
  EMPTY_SHELL_EXTRAS,
  personalStatusOf,
  toV1ThreadShell,
  type PersonalShellExtras,
} from "./PersonalThreadShellV2.ts";

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

const CONTINUATION_PROMPT = "Continue where you left off.";

const writeTitleState =
  (input: {
    readonly threadId: ThreadId;
    readonly source: "manual" | "generated";
    readonly version: string;
  }) =>
  (sql: SqlClient.SqlClient) =>
    sql`
    INSERT INTO personal_thread_title_state (thread_id, source, version, updated_at)
    VALUES (${input.threadId}, ${input.source}, ${input.version}, ${DateTime.formatIso(DateTime.makeUnsafe(Date.now()))})
    ON CONFLICT(thread_id) DO UPDATE SET
      source = excluded.source, version = excluded.version, updated_at = excluded.updated_at
  `;

const engineError = (operation: string) => (failure: unknown) =>
  new PersonalEngineError({ operation, detail: failureDetail(failure) });

interface RetryRow {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryAt: string | null;
  readonly auto: "pending" | "exhausted";
  readonly provider: string;
  readonly observedAt: string;
}

const retryViewOf = (row: RetryRow): PersonalProviderRetryView => ({
  kind: "retrying",
  attempt: row.attempt,
  maxAttempts: row.maxAttempts,
  ...(row.retryAt === null ? {} : { retryAt: row.retryAt }),
  auto: row.auto,
  provider: row.provider,
  observedAt: row.observedAt,
});

interface StoredMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly runId: string | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const parseStoredMessage = (json: string): StoredMessage | null => {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof value.id !== "string" ||
      typeof value.text !== "string" ||
      (value.role !== "user" && value.role !== "assistant" && value.role !== "system") ||
      typeof value.streaming !== "boolean" ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      return null;
    }
    return {
      id: value.id,
      role: value.role,
      text: value.text,
      attachments: Array.isArray(value.attachments)
        ? (value.attachments as ReadonlyArray<ChatAttachment>)
        : [],
      ...(typeof value.context === "object" && value.context !== null
        ? { context: value.context as OrchestrationMessageContext }
        : {}),
      runId: typeof value.runId === "string" ? value.runId : null,
      streaming: value.streaming,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  } catch {
    return null;
  }
};

const isStoredMessage = (value: StoredMessage | null): value is StoredMessage => value !== null;

const toMessageView = (row: StoredMessage): PersonalMessageView => ({
  id: MessageId.make(row.id),
  role: row.role,
  text: row.text,
  ...(row.attachments.length === 0 ? {} : { attachments: row.attachments }),
  ...(row.context === undefined ? {} : { context: row.context }),
  turnId: row.runId === null ? null : TurnId.make(row.runId),
  streaming: row.streaming,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* Effect.serviceOption(PersonalProviderSessions);
  const projects = yield* ProjectService;
  const sql = yield* SqlClient.SqlClient;

  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (threadId: string) =>
    Effect.gen(function* () {
      const existing = locks.get(threadId);
      if (existing !== undefined) return existing;
      const made = yield* Semaphore.make(1);
      locks.set(threadId, made);
      return made;
    });

  const readShell = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.mapError(engineError("getThread")));

  const readExtras = (threadId: ThreadId): Effect.Effect<PersonalShellExtras> =>
    Effect.gen(function* () {
      const drivers = yield* sql<{ readonly driver: string | null }>`
        SELECT COALESCE(driver, provider) AS "driver"
        FROM orchestration_v2_projection_provider_threads
        WHERE thread_id = ${threadId}
        ORDER BY COALESCE(last_run_ordinal, 0) DESC, updated_at DESC
        LIMIT 1
      `;
      const retries = yield* sql<RetryRow>`
        SELECT attempt AS "attempt", max_attempts AS "maxAttempts", retry_at AS "retryAt",
          auto, provider, observed_at AS "observedAt"
        FROM personal_thread_retry
        WHERE thread_id = ${threadId}
      `;
      const retry = retries[0];
      const titleStates = yield* sql<{
        readonly source: "manual" | "generated";
        readonly version: string;
      }>`
        SELECT source, version FROM personal_thread_title_state WHERE thread_id = ${threadId}
      `;
      const titleState = titleStates[0];
      return {
        providerName: drivers[0]?.driver ?? null,
        providerRetry: retry === undefined ? null : retryViewOf(retry),
        titleState:
          titleState === undefined
            ? null
            : {
                source: titleState.source,
                version: titleState.version as CommandId,
                needsRefinement: false,
              },
      };
    }).pipe(Effect.orElseSucceed(() => EMPTY_SHELL_EXTRAS));

  const eventContext: PersonalEventContext = { readShell, readExtras };
  const eventState = makePersonalEventState();
  const notices = yield* EventSinkV2;

  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const readMessageById = (threadId: ThreadId, messageId: MessageId) =>
    sql<{ readonly payloadJson: string }>`
      SELECT payload_json AS "payloadJson"
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
      LIMIT 1
    `.pipe(
      Effect.map(
        (rows) =>
          rows.map((row) => parseStoredMessage(row.payloadJson)).filter(isStoredMessage)[0] ?? null,
      ),
    );

  const writeMessage = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly streaming: boolean;
    readonly createdAt: DateTime.Utc;
    readonly updatedAt: DateTime.Utc;
    readonly context?: OrchestrationMessageContext;
  }): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const event: OrchestrationV2DomainEvent = {
        id: EventId.make(crypto.randomUUID()),
        threadId: input.threadId,
        occurredAt: input.updatedAt,
        type: "message.updated",
        payload: {
          createdBy: "system",
          creationSource: "server",
          id: input.messageId,
          threadId: input.threadId,
          runId: null,
          nodeId: null,
          role: input.role,
          text: input.text,
          attachments: [],
          ...(input.context === undefined ? {} : { context: input.context }),
          streaming: input.streaming,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        },
      };
      yield* notices.write({
        commandId: CommandId.make(`personal-notice:${input.messageId}:${crypto.randomUUID()}`),
        events: [event],
      });
    });

  const createProject = (
    input: CreateProjectInput,
  ): Effect.Effect<ProjectId, PersonalEngineError> =>
    Effect.gen(function* () {
      const projectId = input.projectId ?? ProjectId.make(crypto.randomUUID());
      yield* projects.create({
        commandId: CommandId.make(`personal-engine:project.create:${projectId}`),
        projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        ...(input.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }),
      });
      return projectId;
    }).pipe(Effect.mapError(engineError("createProject")));

  const createThread = (input: CreateThreadInput): Effect.Effect<ThreadId, PersonalEngineError> =>
    Effect.gen(function* () {
      const threadId = input.threadId ?? ThreadId.make(crypto.randomUUID());
      yield* threads.dispatch({
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
        createdBy: "system",
        creationSource: "server",
      });
      return threadId;
    }).pipe(Effect.mapError(engineError("createThread")));

  const send = (input: PersonalSendInput): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const shell = yield* readShell(input.threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell?.deletedAt != null) {
        return yield* new PersonalEngineError({
          operation: "send",
          detail: `Thread '${input.threadId}' is deleted and cannot start a turn.`,
        });
      }
      // A task reopen asks for a fresh provider session; its turn text carries
      // the work record and the turn-start path adds the chat tail.
      const freshContext = isFreshTaskTurn(input.context);
      // The first message may name the chat, but never over a manual rename or
      // a task's own title.
      const titleSeed =
        input.titleSeed === undefined || shell === null
          ? input.titleSeed
          : personalTitleSeedForSend({
              title: shell.title,
              titleState: (yield* readExtras(input.threadId)).titleState,
              messageId: input.messageId,
              titleSeed: input.titleSeed,
            });
      const runs =
        input.mode === "steer" && shell !== null
          ? yield* threads
              .getThreadRecords(input.threadId, ["runs"])
              .pipe(Effect.orElseSucceed(() => null))
          : null;
      const active = runs?.runs
        .filter((run) => ThreadManagementService.isActiveRun(run))
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      const targetRunId = active?.id;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`personal-engine:turn.start:${input.messageId}`),
        threadId: input.threadId,
        messageId: input.messageId,
        text: input.text,
        attachments: input.attachments,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(titleSeed === undefined ? {} : { titleSeed }),
        ...(freshContext ? { freshContext: true } : {}),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        dispatchMode:
          input.mode === "steer" && targetRunId !== undefined
            ? { type: "steer_active", targetRunId }
            : input.mode === "queue"
              ? { type: "queue_after_active" }
              : { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      });
      if (titleSeed !== undefined) {
        yield* writeTitleState({
          threadId: input.threadId,
          source: "generated",
          version: `server:${PERSONAL_TITLE_SEED_COMMAND_TAG}:${input.messageId}`,
        })(sql);
      }
    }).pipe(Effect.mapError(engineError("send")));

  const continueTurn = (
    input: PersonalContinueTurnInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const messageId = MessageId.make(`personal-continue:${crypto.randomUUID()}`);
      // Codex can continue without a prompt, as it did on v1; the empty user
      // message is hidden by the chat and only carries the turn.
      const extras = yield* readExtras(input.threadId);
      const promptless = extras.providerName === "codex";
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`personal-engine:continue:${messageId}`),
        threadId: input.threadId,
        messageId,
        text: promptless ? "" : CONTINUATION_PROMPT,
        attachments: [],
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        dispatchMode: { type: "start_immediately" },
        createdBy: "system",
        creationSource: "server",
      });
    }).pipe(Effect.mapError(engineError("continueTurn")));

  const interrupt = (
    threadId: ThreadId,
    turnId?: TurnId,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const shell = yield* readShell(threadId);
      if (shell === null) {
        return yield* new PersonalEngineError({
          operation: "interrupt",
          detail: `thread ${threadId} does not exist`,
        });
      }
      yield* threads.interruptThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`personal-engine:turn.interrupt:${crypto.randomUUID()}`),
        threadId,
        ...(turnId === undefined ? {} : { runId: RunId.make(turnId) }),
        reason: "Stopped by the personal layer",
      });
    }).pipe(Effect.mapError(engineError("interrupt")));

  const setProviderRetry = (
    input: PersonalSetProviderRetryInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const shell = yield* readShell(input.threadId);
      if (shell === null || (shell.latestRunId === null && shell.status === "idle")) return;
      if (input.retry === null) {
        const existing = yield* sql<{ readonly auto: string | null }>`
          SELECT auto FROM personal_thread_retry WHERE thread_id = ${input.threadId}
        `;
        if (existing.length === 0) return;
        yield* sql`DELETE FROM personal_thread_retry WHERE thread_id = ${input.threadId}`;
        return;
      }
      const observedAt = yield* now;
      const provider =
        (yield* sql<{ readonly driver: string | null }>`
          SELECT COALESCE(driver, provider) AS "driver"
          FROM orchestration_v2_projection_provider_threads
          WHERE thread_id = ${input.threadId}
          ORDER BY COALESCE(last_run_ordinal, 0) DESC, updated_at DESC
          LIMIT 1
        `)[0]?.driver ?? "provider";
      yield* sql`
        INSERT INTO personal_thread_retry
          (thread_id, attempt, max_attempts, retry_at, auto, provider, observed_at)
        VALUES (
          ${input.threadId}, ${input.retry.attempt}, ${input.retry.maxAttempts},
          ${input.retry.retryAt}, ${input.retry.auto}, ${provider}, ${observedAt}
        )
        ON CONFLICT(thread_id) DO UPDATE SET
          attempt = excluded.attempt,
          max_attempts = excluded.max_attempts,
          retry_at = excluded.retry_at,
          auto = excluded.auto,
          provider = excluded.provider,
          observed_at = excluded.observed_at
      `;
    }).pipe(Effect.mapError(engineError("setProviderRetry")));

  const stop = (input: PersonalStopInput): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`personal-engine:session.stop:${crypto.randomUUID()}`),
        threadId: input.threadId,
        stopDelegatedTasks: false,
      });
      // A parked thread has no turn to stop, so thread.stop leaves its provider
      // session ready. Release the process too; the resume note needs a fresh one.
      if (Option.isSome(providerSessions)) {
        yield* providerSessions.value.stopSession({ threadId: input.threadId });
      }
    }).pipe(Effect.mapError(engineError("stop")));

  const archive = (threadId: ThreadId): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* threads.dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`personal-engine:thread.archive:${threadId}`),
        threadId,
      });
    }).pipe(Effect.mapError(engineError("archive")));

  const deleteThread = (threadId: ThreadId): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`personal-engine:thread.delete:${threadId}`),
        threadId,
      });
    }).pipe(Effect.mapError(engineError("deleteThread")));

  const updateMeta = (input: PersonalUpdateMetaInput): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const lock = yield* lockFor(input.threadId);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (
            input.title !== undefined ||
            input.branch !== undefined ||
            input.worktreePath !== undefined
          ) {
            yield* threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`personal-engine:thread.meta:${crypto.randomUUID()}`),
              threadId: input.threadId,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.branch === undefined ? {} : { branch: input.branch }),
              ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
            });
            if (input.title !== undefined) {
              yield* writeTitleState({
                threadId: input.threadId,
                source: "manual",
                version: `personal-engine:thread.meta:${crypto.randomUUID()}`,
              })(sql);
            }
          }
          if (input.modelSelection !== undefined) {
            yield* threads.dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make(`personal-engine:thread.model:${crypto.randomUUID()}`),
              threadId: input.threadId,
              modelSelection: input.modelSelection,
            });
          }
        }),
      );
    }).pipe(Effect.mapError(engineError("updateMeta")));

  const renameThreadIfUnchanged = (
    input: PersonalRenameThreadIfUnchangedInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const lock = yield* lockFor(input.threadId);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const shell = yield* readShell(input.threadId).pipe(Effect.orElseSucceed(() => null));
          if (
            shell === null ||
            shell.deletedAt !== null ||
            shell.title !== input.expectedTitle ||
            shell.titleRegeneration != null
          ) {
            return;
          }
          const commandId = CommandId.make(`personal-engine:thread.title:${crypto.randomUUID()}`);
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId,
            threadId: input.threadId,
            title: input.title,
          });
          yield* writeTitleState({
            threadId: input.threadId,
            source: "generated",
            version: commandId,
          })(sql);
        }),
      );
    }).pipe(Effect.mapError(engineError("renameThreadIfUnchanged")));

  const postNotice = (input: PersonalPostNoticeInput): Effect.Effect<void, PersonalEngineError> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        yield* appendNotice({
          threadId: input.threadId,
          messageId: input.messageId,
          delta: input.text,
          key: "notice",
          ...(input.context === undefined ? {} : { context: input.context }),
        });
        yield* completeNotice({ threadId: input.threadId, messageId: input.messageId });
      }),
    ).pipe(Effect.mapError(engineError("postNotice")));

  const appendNotice = (
    input: PersonalAppendNoticeInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const inserted = yield* sql<{ readonly messageId: string }>`
        INSERT INTO personal_notice_chunks (message_id, chunk_key)
        VALUES (${input.messageId}, ${input.key})
        ON CONFLICT(message_id, chunk_key) DO NOTHING
        RETURNING message_id AS "messageId"
      `;
      if (inserted.length === 0) return;
      const current = yield* readMessageById(input.threadId, input.messageId);
      const at = yield* DateTime.now;
      yield* writeMessage({
        threadId: input.threadId,
        messageId: input.messageId,
        role: "assistant",
        text: (current?.text ?? "") + input.delta,
        streaming: true,
        createdAt: current === null ? at : DateTime.makeUnsafe(current.createdAt),
        updatedAt: at,
        ...(input.context !== undefined
          ? { context: input.context }
          : current?.context === undefined
            ? {}
            : { context: current.context }),
      });
    }).pipe(Effect.mapError(engineError("appendNotice")));

  const completeNotice = (
    input: PersonalCompleteNoticeInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const current = yield* readMessageById(input.threadId, input.messageId);
      if (current === null) return;
      const at = yield* DateTime.now;
      yield* writeMessage({
        threadId: input.threadId,
        messageId: input.messageId,
        role: "assistant",
        text: current.text,
        streaming: false,
        createdAt: DateTime.makeUnsafe(current.createdAt),
        updatedAt: at,
        ...(current.context === undefined ? {} : { context: current.context }),
      });
    }).pipe(Effect.mapError(engineError("completeNotice")));

  const postUserMessage = (
    input: PersonalPostUserMessageInput,
  ): Effect.Effect<void, PersonalEngineError> =>
    Effect.gen(function* () {
      const at = yield* DateTime.now;
      yield* writeMessage({
        threadId: input.threadId,
        messageId: input.messageId,
        role: "user",
        text: input.text,
        streaming: false,
        createdAt: at,
        updatedAt: at,
        ...(input.context === undefined ? {} : { context: input.context }),
      });
    }).pipe(Effect.mapError(engineError("postUserMessage")));

  const getThread = (
    threadId: ThreadId,
  ): Effect.Effect<Option.Option<PersonalThreadView>, PersonalEngineError> =>
    Effect.gen(function* () {
      const shell = yield* readShell(threadId);
      if (shell === null) return Option.none();
      const extras = yield* readExtras(threadId);
      return Option.some(toV1ThreadShell(shell, extras) as PersonalThreadView);
    });

  const getProject = (
    projectId: ProjectId,
  ): Effect.Effect<Option.Option<PersonalProjectView>, PersonalEngineError> =>
    projects.getShell(projectId).pipe(
      Effect.map(
        Option.map((shell): PersonalProjectView => ({
          id: shell.id,
          workspaceRoot: shell.workspaceRoot,
        })),
      ),
      Effect.mapError(engineError("getProject")),
    );

  const listProjects = (): Effect.Effect<ReadonlyArray<PersonalProjectView>, PersonalEngineError> =>
    projects.listShells().pipe(
      Effect.map((shells) =>
        shells.map((shell): PersonalProjectView => ({
          id: shell.id,
          workspaceRoot: shell.workspaceRoot,
        })),
      ),
      Effect.mapError(engineError("listProjects")),
    );

  const latestAssistantMessage = (input: {
    readonly threadId: ThreadId;
    readonly after?: DateTime.Utc;
    readonly afterMessageId?: MessageId;
    readonly turnId?: TurnId;
  }): Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError> =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${input.threadId} AND role = 'assistant'
          ${input.turnId === undefined ? sql`` : sql`AND run_id = ${input.turnId}`}
          ${
            input.after === undefined
              ? sql``
              : input.afterMessageId === undefined
                ? sql`AND created_at > ${DateTime.formatIso(input.after)}`
                : sql`AND (created_at > ${DateTime.formatIso(input.after)}
                    OR (created_at = ${DateTime.formatIso(input.after)}
                      AND message_id > ${input.afterMessageId}))`
          }
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `;
      const found = rows
        .map((row) => parseStoredMessage(row.payloadJson))
        .filter(isStoredMessage)[0];
      return found === undefined ? Option.none() : Option.some(toMessageView(found));
    }).pipe(Effect.mapError(engineError("latestAssistantMessage")));

  const latestUserMessage = (input: {
    readonly threadId: ThreadId;
    readonly excludeIdPrefix?: string;
  }): Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError> =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${input.threadId} AND role = 'user'
          ${
            input.excludeIdPrefix === undefined
              ? sql``
              : sql`AND message_id NOT LIKE ${`${input.excludeIdPrefix}%`}`
          }
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `;
      const found = rows
        .map((row) => parseStoredMessage(row.payloadJson))
        .filter(isStoredMessage)[0];
      return found === undefined ? Option.none() : Option.some(toMessageView(found));
    }).pipe(Effect.mapError(engineError("latestUserMessage")));

  const messageById = (
    messageId: MessageId,
  ): Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError> =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_v2_projection_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `;
      const found = rows
        .map((row) => parseStoredMessage(row.payloadJson))
        .filter(isStoredMessage)[0];
      return found === undefined ? Option.none() : Option.some(toMessageView(found));
    }).pipe(Effect.mapError(engineError("messageById")));

  const messagesByIds = (input: {
    readonly threadId: ThreadId;
    readonly messageIds: ReadonlyArray<MessageId>;
  }): Effect.Effect<ReadonlyArray<PersonalMessageView>, PersonalEngineError> => {
    if (input.messageIds.length === 0) return Effect.succeed([]);
    return sql<{ readonly payloadJson: string }>`
      SELECT payload_json AS "payloadJson"
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${input.threadId}
        AND ${sql.in("message_id", input.messageIds)}
      ORDER BY created_at, message_id
    `.pipe(
      Effect.map((rows) =>
        rows
          .map((row) => parseStoredMessage(row.payloadJson))
          .filter(isStoredMessage)
          .map(toMessageView),
      ),
      Effect.mapError(engineError("messagesByIds")),
    );
  };

  const listMessages = (input: {
    readonly threadId: ThreadId;
    readonly limit: number;
    readonly before?: DateTime.Utc;
  }): Effect.Effect<ReadonlyArray<PersonalMessageView>, PersonalEngineError> => {
    if (input.limit <= 0) return Effect.succeed([]);
    const before = input.before === undefined ? null : DateTime.formatIso(input.before);
    return sql<{ readonly payloadJson: string }>`
      SELECT payload_json AS "payloadJson"
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${input.threadId}
        ${before === null ? sql`` : sql`AND created_at < ${before}`}
      ORDER BY created_at DESC, message_id DESC
      LIMIT ${input.limit}
    `.pipe(
      Effect.map((rows) =>
        rows
          .map((row) => parseStoredMessage(row.payloadJson))
          .filter(isStoredMessage)
          .map(toMessageView)
          .reverse(),
      ),
      Effect.mapError(engineError("listMessages")),
    );
  };

  const latestContextTokens = (
    threadId: ThreadId,
  ): Effect.Effect<number | null, PersonalEngineError> =>
    sql<{ readonly used: number | null }>`
      SELECT json_extract(payload_json, '$.tokenUsage.usedTokens') AS "used"
      FROM orchestration_v2_projection_provider_turns
      WHERE thread_id = ${threadId}
      ORDER BY ordinal DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => (typeof rows[0]?.used === "number" ? rows[0].used : null)),
      Effect.orElseSucceed(() => null),
      Effect.mapError(engineError("latestContextTokens")),
    );

  const compactedSince = (input: {
    readonly threadId: ThreadId;
    readonly since: string;
  }): Effect.Effect<boolean, PersonalEngineError> =>
    sql<{ readonly found: number }>`
      SELECT 1 AS "found"
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId} AND type = 'compaction'
        AND updated_at > ${input.since}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
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
          FROM orchestration_v2_projection_turn_items i
          WHERE i.thread_id = ${input.threadId}
            AND i.type IN ('web_search', 'file_search', 'command_execution', 'file_change',
              'dynamic_tool', 'approval_request', 'subagent')
            AND (
              i.type = 'web_search'
              OR ${sql.or(
                input.needles.map(
                  (needle) =>
                    sql`instr(lower(COALESCE(json_extract(i.payload_json, '$.title'), '') || ' '
                      || substr(COALESCE(json_extract(i.payload_json, '$.input'),
                        json_extract(i.payload_json, '$.prompt'),
                        json_extract(i.payload_json, '$.text'), ''), 1, 80)), ${needle}) > 0`,
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
      readonly itemType: string;
      readonly text: string;
    }>`
      SELECT i.turn_item_id AS "id", i.type AS "itemType",
        COALESCE(json_extract(i.payload_json, '$.title'), '') || ' '
          || substr(COALESCE(json_extract(i.payload_json, '$.input'),
            json_extract(i.payload_json, '$.prompt'),
            json_extract(i.payload_json, '$.text'), ''), 1, 80) AS "text"
      FROM orchestration_v2_projection_turn_items i
      WHERE i.thread_id = ${input.threadId}
        AND i.type IN ('command_execution', 'file_change', 'file_search', 'web_search',
          'dynamic_tool', 'approval_request', 'subagent')
        AND i.updated_at >= ${input.since}
      ORDER BY i.ordinal DESC
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
      SELECT turn_item_id AS "id", type AS "kind", payload_json AS "payloadJson"
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId}
        AND ${sql.in("turn_item_id", input.ids)}
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
        t.thread_id AS "threadId",
        r.run_id AS "turnId",
        (
          SELECT substr(json_extract(i.payload_json, '$.text'), 1, 400)
          FROM orchestration_v2_projection_turn_items i
          WHERE i.thread_id = t.thread_id AND i.type = 'reasoning'
            AND i.updated_at >= MAX(COALESCE(json_extract(t.payload_json, '$.latestUserMessageAt'), ''),
              COALESCE(r.requested_at, ''))
          ORDER BY i.ordinal DESC LIMIT 1
        ) AS "reasoningText",
        (
          SELECT i.updated_at
          FROM orchestration_v2_projection_turn_items i
          WHERE i.thread_id = t.thread_id AND i.type = 'reasoning'
            AND i.updated_at >= MAX(COALESCE(json_extract(t.payload_json, '$.latestUserMessageAt'), ''),
              COALESCE(r.requested_at, ''))
          ORDER BY i.ordinal DESC LIMIT 1
        ) AS "reasoningAt",
        (
          SELECT NULLIF(json_extract(i.payload_json, '$.title'), '')
          FROM orchestration_v2_projection_turn_items i
          WHERE i.thread_id = t.thread_id
            AND i.type IN ('command_execution', 'file_change', 'file_search', 'web_search',
              'dynamic_tool', 'approval_request', 'subagent')
            AND i.updated_at >= MAX(COALESCE(json_extract(t.payload_json, '$.latestUserMessageAt'), ''),
              COALESCE(r.requested_at, ''))
          ORDER BY i.ordinal DESC LIMIT 1
        ) AS "toolTitle",
        (
          SELECT COALESCE(json_extract(i.payload_json, '$.title'), i.type)
          FROM orchestration_v2_projection_turn_items i
          WHERE i.thread_id = t.thread_id
            AND i.type IN ('command_execution', 'file_change', 'file_search', 'web_search',
              'dynamic_tool', 'approval_request', 'subagent')
            AND i.updated_at >= MAX(COALESCE(json_extract(t.payload_json, '$.latestUserMessageAt'), ''),
              COALESCE(r.requested_at, ''))
          ORDER BY i.ordinal DESC LIMIT 1
        ) AS "toolSummary",
        (
          SELECT i.updated_at
          FROM orchestration_v2_projection_turn_items i
          WHERE i.thread_id = t.thread_id
            AND i.type IN ('command_execution', 'file_change', 'file_search', 'web_search',
              'dynamic_tool', 'approval_request', 'subagent')
            AND i.updated_at >= MAX(COALESCE(json_extract(t.payload_json, '$.latestUserMessageAt'), ''),
              COALESCE(r.requested_at, ''))
          ORDER BY i.ordinal DESC LIMIT 1
        ) AS "toolAt"
      FROM orchestration_v2_projection_threads t
      LEFT JOIN orchestration_v2_projection_runs r
        ON r.thread_id = t.thread_id
        AND r.run_id = (
          SELECT rr.run_id FROM orchestration_v2_projection_runs rr
          WHERE rr.thread_id = t.thread_id
          ORDER BY rr.ordinal DESC LIMIT 1
        )
      WHERE ${sql.in("t.thread_id", threadIds)}
        AND t.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs live
          WHERE live.thread_id = t.thread_id AND live.status IN ('running', 'starting')
        )
    `.pipe(Effect.mapError(engineError("workingSnapshot")));
  };

  const liveTaskIds = (
    threadId: ThreadId,
  ): Effect.Effect<ReadonlyArray<string>, PersonalEngineError> =>
    readShell(threadId).pipe(
      Effect.map((shell) => (shell?.pendingBackgroundTasks ?? []).map((task) => task.taskId)),
      Effect.orElseSucceed(() => []),
    );

  const toV1Shells = (shells: ReadonlyArray<Parameters<typeof toV1ThreadShell>[0]>) =>
    Effect.gen(function* () {
      if (shells.length === 0) return [];
      const ids = shells.map((shell) => shell.id);
      const drivers = yield* sql<{ readonly threadId: string; readonly driver: string | null }>`
        SELECT thread_id AS "threadId", COALESCE(driver, provider) AS "driver"
        FROM orchestration_v2_projection_provider_threads
        WHERE ${sql.in("thread_id", ids)}
        ORDER BY COALESCE(last_run_ordinal, 0), updated_at
      `;
      const retries = yield* sql<RetryRow & { readonly threadId: string }>`
        SELECT thread_id AS "threadId", attempt AS "attempt", max_attempts AS "maxAttempts",
          retry_at AS "retryAt", auto, provider, observed_at AS "observedAt"
        FROM personal_thread_retry
        WHERE ${sql.in("thread_id", ids)}
      `;
      const driverByThread = new Map<string, string>();
      for (const row of drivers) {
        if (row.driver !== null) driverByThread.set(row.threadId, row.driver);
      }
      const retryByThread = new Map(retries.map((row) => [row.threadId, row]));
      return shells.map((shell) => {
        const retry = retryByThread.get(shell.id);
        return toV1ThreadShell(shell, {
          providerName: driverByThread.get(shell.id) ?? null,
          providerRetry: retry === undefined ? null : retryViewOf(retry),
          titleState: null,
        });
      });
    });

  const shellSnapshot = (input: {
    readonly unsettledOnly: boolean;
  }): Effect.Effect<ReadonlyArray<OrchestrationThreadShellV1Wire>, PersonalEngineError> =>
    Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot({ unsettledOnly: input.unsettledOnly });
      return yield* toV1Shells([...snapshot.threads, ...snapshot.archivedThreads]);
    }).pipe(Effect.mapError(engineError("shellSnapshot")));

  const threadShells = (
    threadIds: ReadonlyArray<ThreadId>,
  ): Effect.Effect<ReadonlyArray<OrchestrationThreadShellV1Wire>, PersonalEngineError> =>
    Effect.gen(function* () {
      if (threadIds.length === 0) return [];
      const snapshot = yield* threads.getShellSnapshot({ threadIds: [...threadIds] });
      return yield* toV1Shells([...snapshot.threads, ...snapshot.archivedThreads]);
    }).pipe(NodeSqliteClient.readOnly, Effect.mapError(engineError("threadShells")));

  const shape: PersonalEngineShape = {
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
    threadShells,
    events: threads.streamDomainEvents.pipe(
      Stream.flatMap((event) =>
        Stream.fromIterableEffect(toPersonalEvents(event, eventState, eventContext)),
      ),
      Stream.orDie,
    ),
  };

  return PersonalEngine.of(shape);
});

export const PersonalEngineV2Live = Layer.effect(PersonalEngine, make);
