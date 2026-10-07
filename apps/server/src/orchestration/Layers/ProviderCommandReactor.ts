import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  type OrchestrationSessionProviderRetry,
  PERSONAL_TASK_MESSAGE_CONTEXT_KIND,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  withPersonalReplyQuote,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { markSessionReplaced, unmarkSessionReplaced } from "../replacedSessions.ts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import * as PersonalBotRepository from "../../personal/PersonalBotRepository.ts";
import { personalBotSystemInstructions } from "../../personal/personalBotInstructions.ts";
import { buildChatHandoff } from "../../personal/sessionHandoff.ts";
import { botModelSelectionForThread } from "../../personal/botModelSelection.ts";
import { isMissingProviderConversationText } from "../../provider/missingProviderConversation.ts";
import {
  isPersonalTaskMessageId,
  PERSONAL_THREAD_TITLE,
  PERSONAL_TITLE_SEED_COMMAND_TAG,
} from "../../personal/personalThreadTitles.ts";
import * as PersonalMemoryService from "../../personal/memory/PersonalMemoryService.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderWorkspaceMissingError,
} from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import {
  formatThreadTitleContext,
  type ThreadTitleMessage,
} from "../../textGeneration/ThreadTitleContext.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import { uniqueAutomaticTitle, withChatTitleLock } from "../../personal/personalChatTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.settled"
      | "thread.session-set";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";
function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
/**
 * `providerRetry.reason` while the server replaces a provider session that no
 * longer has the chat's conversation and sends the message again on it.
 */
export const SESSION_RENEWED_REASON = "session_renewed";
/** Room left in a turn's input for attachment paths and other context. */
const HANDOFF_INPUT_MARGIN_CHARS = 8_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

/** How much of a chat a fresh task session is given; the work record carries the rest. */
const TASK_FRESH_HANDOFF_CHARS = 6_000;

/** Whether a turn message is a task continuation that asks for a fresh provider session. */
export function isFreshTaskTurn(
  context:
    | { readonly records: ReadonlyArray<{ readonly kind: string; readonly payload?: unknown }> }
    | undefined,
): boolean {
  const record = context?.records.find(
    (entry) => entry.kind === PERSONAL_TASK_MESSAGE_CONTEXT_KIND,
  );
  const payload = record?.payload;
  return (
    typeof payload === "object" &&
    payload !== null &&
    "fresh" in payload &&
    (payload as { readonly fresh?: unknown }).fresh === true
  );
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerAuthService = yield* ProviderAuthService;
  const providerService = yield* ProviderService;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const personalBots = yield* PersonalBotRepository.PersonalBotRepository;
  /**
   * Personal bot instructions for a thread, for the provider session/turn
   * path. Best-effort: a lookup failure starts the session without bot
   * instructions rather than failing the turn.
   */
  const personalMemory = yield* Effect.serviceOption(PersonalMemoryService.PersonalMemoryService);
  const personalBotInstructions = (threadId: ThreadId) =>
    personalBots.getInstructionsForThread({ threadId }).pipe(
      Effect.map((instructions) =>
        Option.getOrUndefined(Option.map(instructions, personalBotSystemInstructions)),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("personal bot instructions lookup failed; continuing without them", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
  /**
   * Every preference the bot can see (capped, newest first) plus up to 6 notes
   * and 6 task summaries relevant to a turn's text ("Known facts (from
   * memory)"), sent as that turn's context rather than in the bot's system
   * instructions: those must read the same on every session start of a
   * conversation, and a Claude session reads them only when it starts. Memory
   * only applies to personal-bot threads and never fails the turn: a lookup
   * that fails is logged and the turn goes without. `preferencesBlock` is the
   * same block without its notes and task summaries, for a turn whose input
   * leaves too little room for all of it. A task or routine attempt (and a
   * steer into one) starts with a personal-task-message; its facts leave out
   * task summaries, which belong to other tasks.
   */
  const personalMemoryForTurn = (
    threadId: ThreadId,
    query: string,
    messageId: MessageId | undefined,
    freshSession: boolean,
  ) =>
    Effect.gen(function* () {
      if (Option.isNone(personalMemory)) return undefined;
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      // The session this turn runs in: the full preference list goes to it
      // once, then only when it changes (see contextForThread).
      const session = yield* providerService.listSessions().pipe(
        Effect.map((sessions) => sessions.find((candidate) => candidate.threadId === threadId)),
        Effect.orElseSucceed(() => undefined),
      );
      const context = yield* personalMemory.value.contextForThread({
        threadId,
        query,
        projectId: Option.isSome(thread) ? thread.value.projectId : undefined,
        record: true,
        ...(messageId !== undefined ? { messageId } : {}),
        excludeTaskSummaries: messageId !== undefined && isPersonalTaskMessageId(messageId),
        session:
          session === undefined
            ? undefined
            : {
                key: `${session.providerInstanceId ?? session.provider}:${session.createdAt}`,
                fresh: freshSession,
              },
      });
      const block = context.block?.trim() ?? "";
      if (block.length === 0) return undefined;
      const preferencesBlock = context.preferencesBlock?.trim() ?? "";
      return {
        block,
        ...(preferencesBlock.length > 0 && preferencesBlock !== block ? { preferencesBlock } : {}),
      };
    }).pipe(
      // contextForThread logs its own failures; this catches what escapes it
      // (a defect in a lookup around it), so the loss is never silent either.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("personal memory lookup failed; sending the turn without memory", {
              threadId,
              errorTag: PersonalMemoryService.errorTagOf(Cause.squash(cause)),
              cause: PersonalMemoryService.redactSecrets(Cause.pretty(cause)).slice(0, 2_000),
            }).pipe(Effect.as(undefined)),
      ),
    );
  /**
   * A bot chat whose bot now runs on another provider than the chat's session
   * (the owner moved the bot, e.g. Claude to Codex). The chat moves with the
   * bot: its next turn runs on the bot's current selection. A session of the
   * other provider can never be resumed, so that turn starts a fresh one and
   * carries the chat over; an instance of the same driver with compatible
   * resume state keeps resuming. Undefined for other threads.
   *
   * The bot's selection wins even when the bot is already on the chat's
   * instance (no new session then): a client holding a stale selection, such
   * as a phone that was backgrounded across the move, would otherwise send the
   * old provider and the turn would be refused as "bound to driver".
   */
  const botProviderSwitch = Effect.fnUntraced(function* (thread: OrchestrationThreadShell) {
    const botSelection = yield* botModelSelectionForThread(personalBots, thread.id, undefined);
    if (botSelection === undefined) return undefined;
    const boundInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
    if (botSelection.instanceId === boundInstanceId) {
      return {
        modelSelection: botSelection,
        freshSession: false,
        fromInstanceId: boundInstanceId,
      } as const;
    }
    const wanted = yield* providerService
      .getInstanceInfo(botSelection.instanceId)
      .pipe(Effect.option);
    // The bot's provider is not configured here: leave the chat where it is.
    if (Option.isNone(wanted)) return undefined;
    const bound = yield* providerService.getInstanceInfo(boundInstanceId).pipe(Effect.option);
    const resumable =
      Option.isSome(bound) &&
      bound.value.driverKind === wanted.value.driverKind &&
      bound.value.continuationIdentity.continuationKey ===
        wanted.value.continuationIdentity.continuationKey;
    return {
      modelSelection: botSelection,
      freshSession: !resumable,
      fromInstanceId: boundInstanceId,
    } as const;
  });
  /**
   * The chat's earlier messages for a turn that starts a fresh session, sized
   * to what the turn's input has room for. Never fails the turn.
   */
  const chatHandoffForTurn = (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId | undefined;
    readonly maxChars: number;
  }) =>
    resolveThreadDetail(input.threadId).pipe(
      Effect.map((thread) =>
        thread === undefined
          ? undefined
          : buildChatHandoff({
              messages: thread.messages,
              currentMessageId: input.messageId,
              maxChars: input.maxChars,
            }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor could not carry the chat over", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
  /**
   * Whether a thread is linked in personal_bot_threads (bot chats, and the
   * task and routine threads that run through them). Title refinement skips
   * these threads, and a user-started chat's first message seeds its title
   * (see personalFirstTurnTitleThread). An explicit "regenerate title" still
   * runs. A failed lookup counts as not personal, which keeps upstream
   * behaviour.
   */
  const isPersonalBotThread = (threadId: ThreadId) =>
    personalBots.getThreadLink({ threadId }).pipe(
      Effect.map(Option.isSome),
      Effect.catchCause((cause) =>
        Effect.logDebug("personal bot thread lookup failed; treating thread as not personal", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
  const terminalManager = yield* TerminalManager.TerminalManager;
  /** Environment settings with the thread's project overrides applied. */
  const projectSettingsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const settings = yield* serverSettingsService.getSettings;
    if (Object.keys(settings.projectSettingsOverrides).length === 0) return settings;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return resolveProjectSettings(settings, Option.isSome(thread) ? thread.value.projectId : null)
      .settings;
  });
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const compactingThreadIds = new Set<ThreadId>();
  type QueuedTurnStart = Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
  // Turn starts received while a thread compacts, replayed in order once its session is restored.
  const turnsAfterCompaction = new Map<ThreadId, Array<QueuedTurnStart>>();
  // Replay command id → the queued turn start it re-requests. `sent` settles once the replay's
  // provider send finishes, which is what lets the next queued turn follow it in order.
  const resumedTurnStarts = new Map<
    CommandId,
    {
      readonly event: QueuedTurnStart;
      readonly queued: Array<QueuedTurnStart>;
      readonly sent: Deferred.Deferred<void>;
    }
  >();
  const stoppingThreadIds = new Set<ThreadId>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const cancelTurnsAfterCompaction = Effect.fn("cancelTurnsAfterCompaction")(function* (
    threadId: ThreadId,
    detail: string,
  ) {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    turnsAfterCompaction.delete(threadId);
    for (const event of queued) {
      yield* appendProviderFailureActivity({
        threadId,
        kind: "provider.turn.start.failed",
        summary: "Queued message was not sent",
        detail,
        turnId: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        requestId: event.payload.messageId,
      }).pipe(Effect.ignore({ log: true, message: "failed to report canceled queued message" }));
    }
  });

  const resumeTurnsAfterCompaction = Effect.fn("resumeTurnsAfterCompaction")(function* (
    threadId: ThreadId,
  ) {
    const queued = turnsAfterCompaction.get(threadId) ?? [];
    while (queued.length > 0 && turnsAfterCompaction.get(threadId) === queued) {
      const event = queued[0]!;
      const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
        threadId,
        messageId: event.payload.messageId,
      });
      if (turnsAfterCompaction.get(threadId) !== queued) return;
      // In flight from here on: a cancellation reports it when the replay runs, not from the queue.
      queued.shift();
      if (Option.isNone(turnStart)) continue;
      // Reissue the durable request after restoration clears compaction's
      // pending slot. Reusing the message id preserves a single user bubble.
      const commandId = yield* serverCommandId("after-compaction");
      const sent = yield* Deferred.make<void>();
      resumedTurnStarts.set(commandId, { event, queued, sent });
      const { messageId, ...request } = event.payload;
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId,
          ...request,
          message: {
            messageId,
            role: "user",
            text: turnStart.value.message.text,
            attachments: turnStart.value.message.attachments ?? [],
          },
        })
        .pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              resumedTurnStarts.delete(commandId);
              queued.unshift(event);
            }),
          ),
        );
      yield* Deferred.await(sent);
      resumedTurnStarts.delete(commandId);
    }
    if (turnsAfterCompaction.get(threadId) === queued) turnsAfterCompaction.delete(threadId);
  });

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    if (isProviderAdapterRequestError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterProcessError(failReason?.error)) {
      return failReason.error.detail;
    }
    if (isProviderAdapterValidationError(failReason?.error)) {
      return failReason.error.issue;
    }
    if (isProviderWorkspaceMissingError(failReason?.error)) {
      return failReason.error.message;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return;
    }
    const currentSession = thread.session;
    // A session renewal that failed is over; its notice goes with it.
    const session =
      currentSession?.providerRetry?.reason === SESSION_RENEWED_REASON
        ? (({ providerRetry: _renewal, ...rest }) => rest)(currentSession)
        : currentSession;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        // Always an error, even when the session already stopped: a message
        // whose turn never started must not sit under an "Idle" header.
        status: "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const restoreCompaction = Effect.fnUntraced(function* (threadId: ThreadId, fromRunning = false) {
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    const thread = yield* resolveThreadShell(threadId);
    if (!thread?.session) return;
    if (
      thread.session.status !== "starting" &&
      thread.session.status !== "ready" &&
      (!fromRunning || thread.session.status !== "running")
    )
      return;
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    if (stoppingThreadIds.has(threadId)) {
      compactingThreadIds.delete(threadId);
      return;
    }
    yield* setThreadSession({
      threadId,
      session: {
        ...thread.session,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        updatedAt: completedAt,
      },
      createdAt: completedAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) {
      return;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return;
    }
    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    // Best effort like the rest of this recovery: a settings read failure
    // falls back to the checkout's t3.json.
    const submodules = yield* projectSettingsForThread(thread.id).pipe(
      Effect.map((settings) => settings.worktreeSubmodules),
      Effect.orElseSucceed(() => null),
    );
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(
        gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath }, { submodules }),
      ),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("provider command reactor failed to recreate worktree", {
            threadId: thread.id,
            worktreePath,
            cause: Cause.pretty(cause),
          }),
      ),
    );
  });

  const resolveThreadShell = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadDetail = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThreadUnlocked = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      // First-turn prompt seed. A manual title that still equals this seed was
      // written by the client's auto-title, not a user rename.
      readonly titleSeed?: string;
      // Start a new provider conversation: stop whatever session the thread
      // has and never resume its persisted one (a bot that moved to another
      // provider, or a conversation the provider no longer has).
      readonly freshSession?: boolean;
      // Shown on the session while it starts (a session renewal's notice).
      readonly providerRetry?: OrchestrationSessionProviderRetry;
    },
  ) {
    const freshSession = options?.freshSession === true;
    const thread = yield* resolveThreadShell(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: freshSession
            ? preferredProvider
            : (activeSession?.provider ?? preferredProvider),
          providerInstanceId: freshSession
            ? desiredInstanceId
            : (activeSession?.providerInstanceId ?? desiredInstanceId),
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          ...(options?.providerRetry !== undefined ? { providerRetry: options.providerRetry } : {}),
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null && !freshSession) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      !freshSession &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    const refreshWorkspaceSnapshot = effectiveCwd
      ? providerRegistry
          .refreshWorkspaceSnapshot({ instanceId: desiredInstanceId, cwd: effectiveCwd })
          .pipe(Effect.forkDetach)
      : Effect.void;
    // OpenCode skips SessionPrompt.ensureTitle when session.create already has
    // a title. Prompt seeds and "New thread" are not user titles, so omit them
    // and let the provider generate one. A real rename is source "manual" and
    // differs from the first-turn prompt seed (the web client writes that seed
    // through thread.meta.update, which also marks the title manual).
    const manualTitle = thread.titleState?.source === "manual" ? thread.title.trim() : "";
    const promptSeed = options?.titleSeed?.trim();
    const sessionTitle =
      manualTitle.length > 0 && manualTitle !== promptSeed ? thread.title : undefined;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
      readonly freshSession?: boolean;
    }) =>
      personalBotInstructions(threadId).pipe(
        Effect.flatMap((systemInstructions) =>
          providerService
            .startSession(threadId, {
              threadId,
              ...(preferredProvider ? { provider: preferredProvider } : {}),
              providerInstanceId: desiredInstanceId,
              ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
              ...(sessionTitle ? { title: sessionTitle } : {}),
              modelSelection: desiredModelSelection,
              ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
              ...(input?.freshSession === true ? { freshSession: true } : {}),
              ...(systemInstructions !== undefined ? { systemInstructions } : {}),
              runtimeMode: desiredRuntimeMode,
            })
            .pipe(Effect.tap(() => refreshWorkspaceSnapshot)),
        ),
      );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            ...(options?.providerRetry !== undefined
              ? { providerRetry: options.providerRetry }
              : {}),
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    if (freshSession) {
      if (activeSession !== undefined) {
        // The old session's exit arrives after this stop. On the same provider
        // instance it looks like the new session's own, so the stop is marked:
        // the ingestion ignores that one exit instead of reading it as the end
        // of the turn that caused the restart.
        // Set before the stop: the exit can arrive before stopSession returns.
        const markId = markSessionReplaced({
          threadId,
          provider: activeSession.provider,
          instanceId: activeSession.providerInstanceId,
          nowMs: DateTime.toEpochMillis(yield* DateTime.now),
        });
        const stopped = yield* providerService.stopSession({ threadId }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("provider command reactor could not stop the replaced session", {
                  threadId,
                  provider: activeSession.provider,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(false)),
          ),
        );
        // A stop that failed, or that left the session listed, stopped nothing:
        // no exit will come for the mark, and it must not wait to swallow the
        // exit of a new session that fails.
        const stillListed = stopped
          ? yield* providerService.listSessions().pipe(
              Effect.map((sessions) => sessions.some((session) => session.threadId === threadId)),
              Effect.orElseSucceed(() => false),
            )
          : false;
        if (!stopped || stillListed) unmarkSessionReplaced(threadId, markId);
      }
      yield* Effect.logInfo("provider command reactor starting a fresh provider session", {
        threadId,
        previousProvider: activeSession?.provider ?? thread.session?.providerName ?? null,
        previousInstanceId: thread.session?.providerInstanceId ?? null,
        desiredInstanceId,
      });
      const freshStarted = yield* startProviderSession({ freshSession: true });
      yield* bindSessionToThread(freshStarted);
      return freshStarted.threadId;
    }

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        yield* refreshWorkspaceSnapshot;
        return existingSessionThreadId;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  // One session start per thread at a time: a prewarm runs outside the worker,
  // so a send arriving mid-prewarm waits for it and then reuses its session
  // instead of starting a second one.
  const threadSessionLocks = new Map<ThreadId, Semaphore.Semaphore>();
  const withThreadSessionLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) => {
    let lock = threadSessionLocks.get(threadId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      threadSessionLocks.set(threadId, lock);
    }
    return lock.withPermit(effect);
  };
  const ensureSessionForThread = (
    threadId: ThreadId,
    createdAt: string,
    options?: Parameters<typeof ensureSessionForThreadUnlocked>[2],
  ) =>
    withThreadSessionLock(threadId, ensureSessionForThreadUnlocked(threadId, createdAt, options));

  const prewarmSession: ProviderCommandReactorShape["prewarmSession"] = (input) =>
    withThreadSessionLock(
      input.threadId,
      Effect.gen(function* () {
        const thread = yield* resolveThreadShell(input.threadId);
        if (!thread) return "missing" as const;
        if (thread.archivedAt !== null) return "archived" as const;
        if (
          thread.worktreePath !== null ||
          compactingThreadIds.has(input.threadId) ||
          turnsAfterCompaction.has(input.threadId) ||
          stoppingThreadIds.has(input.threadId)
        ) {
          return "busy" as const;
        }
        const activeSession = (yield* providerService.listSessions()).find(
          (session) => session.threadId === input.threadId,
        );
        if (
          activeSession !== undefined &&
          thread.session !== null &&
          thread.session.status !== "stopped"
        ) {
          return "live" as const;
        }
        const info = yield* providerService.getInstanceInfo(input.modelSelection.instanceId);
        if (info.driverKind !== "claudeAgent") return "unsupported" as const;
        yield* ensureSessionForThreadUnlocked(
          input.threadId,
          DateTime.formatIso(yield* DateTime.now),
          { modelSelection: input.modelSelection },
        );
        // The next send compares its selection with this one; a match reuses
        // the session instead of restarting it.
        threadModelSelections.set(input.threadId, input.modelSelection);
        return "started" as const;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("provider command reactor session prewarm failed", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as("failed" as const)),
      ),
    );

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId?: MessageId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
    readonly titleSeed?: string;
    /** Start a fresh provider session and carry the chat over to it. */
    readonly freshSession?: boolean;
    /** At most this much of the earlier chat is carried over (a task's work record carries the rest). */
    readonly handoffMaxChars?: number;
    readonly providerRetry?: OrchestrationSessionProviderRetry;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
      ...(input.freshSession === true ? { freshSession: true } : {}),
      ...(input.providerRetry !== undefined ? { providerRetry: input.providerRetry } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const systemInstructions = yield* personalBotInstructions(input.threadId);
    const memory = normalizedInput
      ? yield* personalMemoryForTurn(
          input.threadId,
          input.messageText,
          input.messageId,
          input.freshSession === true,
        )
      : undefined;
    const memoryContext = memory?.block;
    // A fresh session knows nothing of the chat: its earlier messages go in
    // front of the memory, in whatever room the turn's input has left.
    const handoff =
      input.freshSession === true
        ? yield* chatHandoffForTurn({
            threadId: input.threadId,
            messageId: input.messageId,
            maxChars: Math.min(
              input.handoffMaxChars ?? Number.POSITIVE_INFINITY,
              PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
                input.messageText.length -
                (memoryContext?.length ?? 0) -
                HANDOFF_INPUT_MARGIN_CHARS,
            ),
          })
        : undefined;
    const withHandoff = (memoryText: string | undefined) =>
      handoff !== undefined && memoryText !== undefined
        ? `${handoff}\n\n${memoryText}`
        : (handoff ?? memoryText);
    const turnContext = withHandoff(memoryContext);
    // What the turn falls back to when the input leaves too little room, most
    // complete first: the preferences without the notes and task summaries,
    // then the memory without the chat handoff (the handoff is sized to the
    // room that was left, so it is what a long input squeezes out first).
    const turnContextFallbacks: Array<{ text: string; dropped: string }> = [
      ...(memory?.preferencesBlock !== undefined
        ? [
            {
              text: withHandoff(memory.preferencesBlock)!,
              dropped: "notes and task summaries",
            },
          ]
        : []),
      ...(handoff !== undefined && memoryContext !== undefined
        ? [
            {
              text: memory?.preferencesBlock ?? memoryContext,
              dropped:
                memory?.preferencesBlock !== undefined
                  ? "notes, task summaries and the earlier-chat handoff"
                  : "the earlier-chat handoff",
            },
          ]
        : []),
    ];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(systemInstructions !== undefined ? { systemInstructions } : {}),
      ...(turnContext !== undefined ? { turnContext } : {}),
      ...(turnContext !== undefined && turnContextFallbacks.length > 0
        ? { turnContextFallbacks }
        : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* projectSettingsForThread(input.threadId);
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
      readonly expectedTitle: string;
      readonly expectedVersion: CommandId | null;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } = yield* projectSettingsForThread(
          input.threadId,
        );

        const generated = yield* textGeneration
          .generateThreadTitle({
            cwd: input.cwd,
            message: input.messageText,
            ...(attachments.length > 0 ? { attachments } : {}),
            modelSelection,
          })
          .pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("2 seconds"),
            }),
          );
        if (!generated) return;

        const thread = yield* resolveThreadShell(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        // A bot's open chats have unique names: a taken AI title gets a number.
        yield* withChatTitleLock(
          Effect.gen(function* () {
            const title = yield* uniqueAutomaticTitle(personalBots, {
              threadId: input.threadId,
              title:
                generated.title === DEFAULT_THREAD_TITLE ? input.expectedTitle : generated.title,
            });
            yield* orchestrationEngine.dispatch({
              type: "thread.title.generate.complete",
              commandId: yield* serverCommandId("thread-title-rename"),
              threadId: input.threadId,
              title,
              expectedTitle: input.expectedTitle,
              expectedVersion: input.expectedVersion,
              needsRefinement:
                generated.needsRefinement === true || generated.title === DEFAULT_THREAD_TITLE,
            });
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  /**
   * The thread state the first-turn title generator judges, or null to leave
   * the title alone.
   * - A task or routine turn (message id from PersonalTaskService) keeps the
   *   thread's title.
   * - A bot chat the user started is still on its placeholder title. Its
   *   first-message seed becomes the title now, as a generated (not manual)
   *   title, so the chat never stays on the placeholder even when generation
   *   fails, and the AI title can replace the seed once. Refinement stays off
   *   for personal bot threads (maybeRefineThreadTitle).
   * - A manual rename wins, and every other thread is returned unchanged.
   * Never fails: a title problem must not fail the turn start.
   */
  const personalFirstTurnTitleThread = Effect.fn("personalFirstTurnTitleThread")(
    function* (input: {
      readonly thread: OrchestrationThreadShell;
      readonly messageId: MessageId;
      readonly titleSeed: string | undefined;
    }) {
      const { thread, titleSeed } = input;
      if (isPersonalTaskMessageId(input.messageId)) return null;
      const title = thread.title.trim();
      if (
        titleSeed === undefined ||
        thread.titleState?.source === "manual" ||
        (title !== PERSONAL_THREAD_TITLE && title !== DEFAULT_THREAD_TITLE) ||
        !(yield* isPersonalBotThread(thread.id))
      ) {
        return thread;
      }
      // The first message names the chat; a name another open chat of the bot
      // already has gets a number after it.
      yield* withChatTitleLock(
        Effect.gen(function* () {
          const title = yield* uniqueAutomaticTitle(personalBots, {
            threadId: thread.id,
            title: titleSeed,
          });
          yield* orchestrationEngine.dispatch({
            type: "thread.title.generate.complete",
            commandId: yield* serverCommandId(PERSONAL_TITLE_SEED_COMMAND_TAG),
            threadId: thread.id,
            title,
            expectedTitle: thread.title,
            expectedVersion: thread.titleState?.version ?? null,
            needsRefinement: false,
          });
        }),
      );
      return (yield* resolveThreadShell(thread.id)) ?? null;
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to seed a personal thread title", {
            threadId: input.thread.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(null)),
        ),
      ),
  );

  const maybeRefineThreadTitle = Effect.fn("maybeRefineThreadTitle")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* resolveThreadShell(threadId);
    if (
      !thread?.titleState?.needsRefinement ||
      thread.titleState.source !== "generated" ||
      thread.titleRegeneration != null ||
      thread.latestTurn?.state !== "completed" ||
      thread.session?.status !== "ready"
    )
      return;
    if (yield* isPersonalBotThread(threadId)) return;
    const detail = yield* resolveThreadDetail(threadId);
    if (!detail || detail.messages.filter((message) => message.role === "user").length !== 1)
      return;
    yield* orchestrationEngine.dispatch({
      type: "thread.title.refine",
      commandId: yield* serverCommandId("thread-title-refine"),
      threadId,
      expectedVersion: thread.titleState.version,
    });
  });

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      yield* serverSettingsService.getSettings,
      thread.projectId,
    ).settings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThreadShell(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* withChatTitleLock(
      Effect.gen(function* () {
        const title =
          input.title === undefined
            ? undefined
            : yield* uniqueAutomaticTitle(personalBots, {
                threadId: input.threadId,
                title: input.title,
              });
        yield* orchestrationEngine.dispatch({
          type: "thread.title.regeneration.complete",
          commandId: yield* serverCommandId("thread-title-regeneration-complete"),
          threadId: input.threadId,
          requestId: input.requestId,
          ...(title !== undefined ? { title } : {}),
        });
      }),
    );
  });
  const findPendingThreadTitles = Effect.fn("findPendingThreadTitles")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return {
      interruptedRegenerations: readModel.threads.flatMap((thread) => {
        const requestId = thread.titleRegeneration?.requestId;
        return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
      }),
      refinementThreadIds: readModel.threads
        .filter((thread) => thread.titleState?.needsRefinement)
        .map((thread) => thread.id),
    };
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor failed to regenerate thread title", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const)),
        ),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor retrying title regeneration completion", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion))),
        ),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("provider command reactor failed to complete title regeneration", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    receivedEvent: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const resumed =
      receivedEvent.commandId !== null ? resumedTurnStarts.get(receivedEvent.commandId) : undefined;
    const event = resumed ? { ...receivedEvent, payload: resumed.event.payload } : receivedEvent;
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
      threadId: thread.id,
      messageId: event.payload.messageId,
    });
    if (Option.isNone(turnStart) || turnStart.value.message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
      return;
    }
    const { message, hasOtherUserMessages } = turnStart.value;
    const appendTurnStartFailure = (summary: string, detail: string) =>
      appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary,
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      });
    if (resumed && turnsAfterCompaction.get(event.payload.threadId) !== resumed.queued) {
      return yield* appendTurnStartFailure(
        "Queued message was not sent",
        "The queued message was canceled before it could resume. Send it again to continue.",
      );
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() => appendTurnStartFailure("Provider turn start failed", detail)),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const authCommandHandled = yield* Effect.gen(function* () {
      // Native account commands belong to the thread's existing provider session.
      const instanceId =
        thread.session?.providerInstanceId ??
        event.payload.modelSelection?.instanceId ??
        thread.modelSelection.instanceId;
      const handled = yield* providerAuthService.tryHandlePromptCommand({
        instanceId,
        text: message.text,
        hasAttachments: (message.attachments?.length ?? 0) > 0,
      });
      if (!handled) {
        return false;
      }

      const instanceInfo = yield* providerService.getInstanceInfo(instanceId);
      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "stopped",
          providerName: instanceInfo.driverKind,
          providerInstanceId: instanceId,
          runtimeMode: thread.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("provider-sign-out"),
        threadId: thread.id,
        activity: {
          id: yield* serverEventId(),
          tone: "info",
          kind: "provider.auth.signed-out",
          summary: "Provider signed out",
          payload: { providerInstanceId: instanceId },
          turnId: null,
          createdAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
      return true;
    }).pipe(Effect.catchCause((cause) => recoverTurnStartFailure(cause).pipe(Effect.as(true))));
    if (authCommandHandled) {
      return;
    }

    yield* ensureThreadWorktree(thread);

    const isCompactCommand = isCompactCommandMessage(message);
    if (!hasOtherUserMessages && !isCompactCommand) {
      const project = yield* resolveProject(thread.projectId);
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: assistantCitationsToPlainText(message.text),
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      const titleThread = yield* personalFirstTurnTitleThread({
        thread,
        messageId: event.payload.messageId,
        titleSeed: event.payload.titleSeed,
      });
      // The seed may have been written with a number after it to stay unique;
      // the chat's own title is then the seed the AI title replaces.
      const seedWasApplied =
        titleThread !== null && titleThread !== thread && titleThread.title !== thread.title;
      const titleSeed = seedWasApplied ? titleThread.title : event.payload.titleSeed;
      if (
        titleThread !== null &&
        titleThread.titleState?.source !== "manual" &&
        canReplaceThreadTitle(titleThread.title, titleSeed)
      ) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          expectedTitle: titleThread.title,
          expectedVersion: titleThread.titleState?.version ?? null,
          ...generationInput,
          ...(seedWasApplied ? { titleSeed: titleThread.title } : {}),
        }).pipe(Effect.forkScoped);
      }
    }

    let compactionSessionEnsured = false;
    const handleCompactionFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      if (!compactionSessionEnsured) {
        return setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.flatMap(() => appendTurnStartFailure("Context compaction failed", detail)),
          Effect.asVoid,
        );
      }
      return appendTurnStartFailure("Context compaction failed", detail).pipe(
        Effect.ensuring(
          restoreCompaction(event.payload.threadId).pipe(
            Effect.catchCause((restoreCause) =>
              Effect.logWarning("failed to restore provider session after compaction failure", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(restoreCause),
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    };
    const recoverCompactionFailure = (cause: Cause.Cause<unknown>) =>
      handleCompactionFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover compaction failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );
    if (isCompactCommand) {
      if (!hasOtherUserMessages) {
        return yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction requires an existing conversation.",
        );
      }
      const latestThread = yield* resolveThreadShell(event.payload.threadId);
      if (
        compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId) ||
        latestThread?.session?.status === "starting" ||
        latestThread?.session?.status === "running"
      ) {
        yield* appendTurnStartFailure(
          "Context compaction failed",
          "Context compaction is unavailable while a provider turn is running.",
        );
        return;
      }
      compactingThreadIds.add(event.payload.threadId);
      const clearCompacting = Effect.sync(
        () => void compactingThreadIds.delete(event.payload.threadId),
      );
      yield* Effect.gen(function* () {
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.payload.createdAt,
          event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection, pendingTurnStart: true }
            : { pendingTurnStart: true },
        );
        compactionSessionEnsured = true;
        if (event.payload.modelSelection !== undefined) {
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
        }
        yield* providerService.compactThread(
          event.payload.threadId,
          event.payload.modelSelection,
          event.payload.messageId,
        );
      }).pipe(
        Effect.andThen(restoreCompaction(event.payload.threadId, true)),
        Effect.andThen(clearCompacting),
        Effect.andThen(resumeTurnsAfterCompaction(event.payload.threadId)),
        Effect.catchCause((cause) =>
          recoverCompactionFailure(cause).pipe(
            Effect.ensuring(clearCompacting),
            Effect.andThen(
              cancelTurnsAfterCompaction(
                event.payload.threadId,
                "Context compaction failed. Send this message again to continue.",
              ),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      return;
    }
    if (
      !resumed &&
      (compactingThreadIds.has(event.payload.threadId) ||
        turnsAfterCompaction.has(event.payload.threadId))
    ) {
      const queued = turnsAfterCompaction.get(event.payload.threadId) ?? [];
      queued.push(event);
      turnsAfterCompaction.set(event.payload.threadId, queued);
      return;
    }
    const turnInput = {
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      // A reply keeps its quote off the stored text; the model reads it here.
      messageText: withPersonalReplyQuote(
        projectComposerContextForProvider({
          text: message.text,
          records: message.context?.records ?? [],
        }),
        message.context,
      ),
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
      // Later turns must not reuse the current title as titleSeed. Only the
      // first prompt seed should suppress a not-yet-renamed session title.
      ...(!hasOtherUserMessages && event.payload.titleSeed !== undefined
        ? { titleSeed: event.payload.titleSeed }
        : {}),
    };
    const sendTurnRequest = yield* Effect.gen(function* () {
      // A bot chat follows its bot to another provider on its next turn.
      // A reopened long task asks for a fresh session itself (its turn text
      // carries the work record): only the tail of the chat is carried over.
      const taskFresh = isFreshTaskTurn(message.context);
      const providerSwitch = yield* botProviderSwitch(thread);
      if (providerSwitch?.freshSession === true) {
        yield* Effect.logInfo("provider command reactor moving a bot chat to its bot's provider", {
          threadId: thread.id,
          fromInstanceId: providerSwitch.fromInstanceId,
          toInstanceId: providerSwitch.modelSelection.instanceId,
          model: providerSwitch.modelSelection.model,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("bot-provider-switch"),
          threadId: thread.id,
          modelSelection: providerSwitch.modelSelection,
        });
      }
      const modelSelection = providerSwitch?.modelSelection ?? event.payload.modelSelection;
      const request = yield* buildSendTurnRequestForThread({
        ...turnInput,
        ...(modelSelection !== undefined ? { modelSelection } : {}),
        ...(providerSwitch?.freshSession === true || taskFresh ? { freshSession: true } : {}),
        ...(taskFresh ? { handoffMaxChars: TASK_FRESH_HANDOFF_CHARS } : {}),
      });
      return {
        request,
        modelSelection,
        fresh: providerSwitch?.freshSession === true || taskFresh,
      } as const;
    }).pipe(
      Effect.asSome,
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    // The provider no longer has the conversation this session resumed (a
    // Claude transcript that is gone, a Codex thread it cannot find). Resuming
    // again cannot work, so start a fresh session once, carry the chat over,
    // and send the same message, attachments included, on it.
    const renewSessionAndSend = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        const current = yield* resolveThreadShell(event.payload.threadId);
        const previousProvider =
          current?.session?.providerName ?? thread.session?.providerName ?? "provider";
        yield* Effect.logWarning(
          "provider command reactor renewing a session that lost its conversation",
          {
            threadId: event.payload.threadId,
            provider: previousProvider,
            cause: Cause.pretty(cause),
          },
        );
        const providerRetry: OrchestrationSessionProviderRetry = {
          kind: "retrying",
          attempt: 1,
          maxAttempts: 1,
          reason: SESSION_RENEWED_REASON,
          provider: previousProvider,
          observedAt: DateTime.formatIso(yield* DateTime.now),
          auto: "pending",
        };
        const { modelSelection } = sendTurnRequest.value;
        const request = yield* buildSendTurnRequestForThread({
          ...turnInput,
          ...(modelSelection !== undefined ? { modelSelection } : {}),
          freshSession: true,
          providerRetry,
        });
        return yield* providerService.sendTurn(request);
      });

    const send = providerService.sendTurn(sendTurnRequest.value.request).pipe(
      Effect.catchCause((cause) =>
        !sendTurnRequest.value.fresh &&
        !Cause.hasInterruptsOnly(cause) &&
        isMissingProviderConversationText(Cause.pretty(cause))
          ? renewSessionAndSend(cause)
          : Effect.failCause(cause),
      ),
      // The bot has its memory's preference list only once the send went
      // through with the block in front of the prompt; a failed send, or one
      // that had to leave the block out, leaves the full list due next time.
      Effect.tap((turn) =>
        Option.isSome(personalMemory) && turn.turnContextDelivery !== "none"
          ? personalMemory.value.confirmPreferencesSent(event.payload.threadId)
          : Effect.void,
      ),
      Effect.asVoid,
      Effect.catchCause(recoverTurnStartFailure),
    );
    // The forked send settles `sent` from here on, so drop the entry the post-processing hook uses.
    if (resumed && event.commandId !== null) resumedTurnStarts.delete(event.commandId);
    yield* send.pipe(
      Effect.ensuring(resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void),
      Effect.forkScoped,
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    yield* cancelTurnsAfterCompaction(
      event.payload.threadId,
      "Context compaction was interrupted. Send this message again to continue.",
    );
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const detail = formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThreadShell(event.payload.threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: Cause.pretty(cause),
              },
            );
          }),
        );
        const stoppedThread = yield* resolveThreadShell(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
          ...(event.payload.attachmentsByQuestionId
            ? { attachmentsByQuestionId: event.payload.attachmentsByQuestionId }
            : {}),
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    const wasCompacting = compactingThreadIds.has(thread.id);
    stoppingThreadIds.add(thread.id);
    const clearStopping = Effect.sync(() => void stoppingThreadIds.delete(thread.id));
    yield* cancelTurnsAfterCompaction(
      thread.id,
      "The session was stopped during context compaction. Send this message again to continue.",
    ).pipe(
      Effect.andThen(
        thread.session && thread.session.status !== "stopped"
          ? providerService.stopSession({
              threadId: thread.id,
              ...(event.payload.terminateProcesses === true ? { terminateProcesses: true } : {}),
            })
          : Effect.void,
      ),
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          const detail = formatFailureDetail(cause);
          return Effect.sync(() => {
            stoppingThreadIds.delete(thread.id);
            return wasCompacting && !compactingThreadIds.has(thread.id);
          }).pipe(
            Effect.flatMap((compactionSettled) =>
              compactionSettled ? restoreCompaction(thread.id) : Effect.void,
            ),
            Effect.andThen(
              appendProviderFailureActivity({
                threadId: thread.id,
                kind: "provider.session.stop.failed",
                summary: "Provider session stop failed",
                detail,
                turnId: null,
                createdAt: now,
              }),
            ),
          );
        },
        onSuccess: () =>
          setThreadSession({
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "stopped",
              providerName: thread.session?.providerName ?? null,
              ...(thread.session?.providerInstanceId !== undefined
                ? { providerInstanceId: thread.session.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
              activeTurnId: null,
              lastError: thread.session?.lastError ?? null,
              updatedAt: now,
            },
            createdAt: now,
          }),
      }),
      Effect.ensuring(clearStopping),
    );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        if (event.payload.regenerateTitle) yield* threadTitleRegenerationWorker.enqueue(event);
        else if (event.payload.titleState?.needsRefinement)
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.session-set":
        if (event.payload.session.status === "ready")
          yield* maybeRefineThreadTitle(event.payload.threadId);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        const resume = ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        yield* thread.worktreePath
          ? withWorkspaceLease(path.resolve(thread.worktreePath), resume)
          : resume;
        return;
      }
      case "thread.turn-start-requested": {
        const thread = yield* resolveThreadShell(event.payload.threadId);
        yield* thread?.worktreePath
          ? withWorkspaceLease(path.resolve(thread.worktreePath), processTurnStartRequested(event))
          : processTurnStartRequested(event);
        return;
      }
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.settled": {
        const thread = yield* projectionSnapshotQuery.getThreadShellById(event.payload.threadId);
        // A thread re-engaged before this event ran keeps its shells and session.
        if (Option.isNone(thread) || thread.value.settledOverride !== "settled") {
          return;
        }
        // Idle shells close so they stop holding the worktree. A terminal that
        // runs a command (a dev server, an editor) stays for the user to close.
        yield* terminalManager.closeIdle({ threadId: event.payload.threadId });
        if (thread.value.session == null || thread.value.session.status === "stopped") {
          return;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`session-stop-for-settle:${event.commandId ?? event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
          onlyIfSettled: true,
        });
        return;
      }
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      // A replay that returned before forking its send still holds its entry; settle it so
      // the compaction queue moves on. Forked sends drop the entry first and settle it themselves.
      Effect.ensuring(
        Effect.suspend(() => {
          const resumed = event.commandId !== null && resumedTurnStarts.get(event.commandId);
          return resumed ? Deferred.succeed(resumed.sent, undefined) : Effect.void;
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const pendingTitles = yield* findPendingThreadTitles().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to find pending thread titles", {
          failureKind: Cause.hasDies(cause) ? "defect" : "failure",
          reasonCount: cause.reasons.length,
        }).pipe(Effect.as({ interruptedRegenerations: [], refinementThreadIds: [] }));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" &&
          (event.payload.regenerateTitle === true ||
            event.payload.titleState?.needsRefinement === true)) ||
        (event.type === "thread.session-set" && event.payload.session.status === "ready") ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested" ||
        event.type === "thread.settled"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    // Subscribe before returning, even while event handling waits for server activation.
    const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(domainEvents, processEvent));

    // Earlier events do not replay. Clear interrupted requests by their captured
    // IDs, then schedule persisted refinements after subscribing to their events.
    const recoverTitles = clearInterruptedThreadTitleRegenerations(
      pendingTitles.interruptedRegenerations,
    ).pipe(
      Effect.andThen(
        Effect.forEach(pendingTitles.refinementThreadIds, maybeRefineThreadTitle, {
          discard: true,
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to recover pending thread titles",
          {
            failureKind: Cause.hasDies(cause) ? "defect" : "failure",
            reasonCount: cause.reasons.length,
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* recoverTitles;
    } else {
      yield* forkParked(recoverTitles);
    }
  });

  return {
    start,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
    prewarmSession,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
