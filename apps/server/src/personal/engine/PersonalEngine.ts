/**
 * The personal view of an orchestrator thread.
 *
 * Personal code needs nine verbs, five reads and one event stream. It does not
 * need v1's command union or v2's. Two implementations sit behind this shape:
 * v1 wraps OrchestrationEngine, ProjectionSnapshotQuery and the projection
 * repos; v2 wraps OrchestratorV2, ThreadManagementService, ProjectionStore and
 * EventSinkV2. Callers import only this module.
 *
 * @module personal/engine/PersonalEngine
 */
import type {
  ChatAttachment,
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  OrchestrationMessageRole,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { PersonalEngineError } from "./errors.ts";

export type PersonalSendMode = "start" | "queue" | "steer";

export interface PersonalTurnFailure {
  readonly message: string | null;
  readonly providerRetry: {
    readonly kind: "rate_limited" | "retrying";
    readonly retryAt: string | null;
  } | null;
}

export type PersonalTurnOutcome =
  | { readonly _tag: "Completed" }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Failed"; readonly failure: PersonalTurnFailure };

export type PersonalThreadStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "stopped"
  | "interrupted"
  | "error";

/** A provider wait: the provider's own, or the server re-running a failed turn. */
export interface PersonalProviderRetryView {
  readonly kind: "rate_limited" | "retrying";
  readonly retryAt?: string;
  readonly attempt?: number;
  readonly maxAttempts?: number;
  readonly reason?: string;
  readonly provider: string;
  readonly observedAt: string;
  readonly auto?: "pending" | "exhausted";
}

/**
 * The session a status event carries. Subscribers that only need to know
 * whether a turn runs can read `status`; the ones that decide about a failure
 * read the provider wait and the error text from the same event.
 */
export interface PersonalSessionView {
  readonly threadId: ThreadId;
  readonly status: PersonalThreadStatus;
  readonly activeTurnId: TurnId | null;
  readonly lastError: string | null;
  readonly providerInstanceId: string | null;
  readonly providerName: string | null;
  readonly providerRetry: PersonalProviderRetryView | null;
  readonly updatedAt: string;
}

/** A request for the owner's input, as a push notification sees it. */
export interface PersonalActivityView {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * One tool step as the memory origin rule reads it. The text is what the
 * provider showed for the step (its summary, title and a clipped detail), so
 * the rule matches the same words on v1 activities and v2 turn items.
 */
export interface PersonalToolStepView {
  readonly id: string;
  readonly itemType: string | null;
  readonly text: string;
}

/** The newest reasoning and tool step of every running chat, for its list row. */
export interface PersonalWorkingRow {
  readonly threadId: ThreadId;
  readonly turnId: TurnId | null;
  readonly reasoningText: string | null;
  readonly reasoningAt: string | null;
  readonly toolTitle: string | null;
  readonly toolSummary: string | null;
  readonly toolAt: string | null;
}

export type PersonalThreadEvent =
  | {
      readonly _tag: "TurnStartRequested";
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly interactionMode: ProviderInteractionMode;
    }
  | {
      readonly _tag: "MessageSent";
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly role: "user" | "assistant";
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly _tag: "TurnEnded";
      readonly threadId: ThreadId;
      readonly outcome: PersonalTurnOutcome;
      readonly session: PersonalSessionView;
    }
  | {
      readonly _tag: "StatusChanged";
      readonly threadId: ThreadId;
      readonly status: PersonalThreadStatus;
      readonly session: PersonalSessionView;
    }
  | {
      readonly _tag: "ActivityAppended";
      readonly threadId: ThreadId;
      readonly activity: PersonalActivityView;
    }
  | { readonly _tag: "TurnStopRequested"; readonly threadId: ThreadId }
  | { readonly _tag: "ThreadArchived"; readonly threadId: ThreadId }
  | { readonly _tag: "ThreadUnarchived"; readonly threadId: ThreadId }
  | { readonly _tag: "ThreadDeleted"; readonly threadId: ThreadId };

/**
 * A thread as personal code reads it. v1's shell carries everything callers
 * use today; A10 vendors the same structure into personalV1Wire, so this alias
 * disappears without a caller change.
 */
export type PersonalThreadView = OrchestrationThreadShell;
export type OrchestrationThreadShellV1Wire = OrchestrationThreadShell;

export interface PersonalMessageView {
  readonly id: MessageId;
  readonly role: OrchestrationMessageRole;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly turnId: TurnId | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProjectInput {
  /** Supplied when a personal row already owns the id. */
  readonly projectId?: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing?: boolean;
}

/** The personal workspace project, as the chat services read it. */
export interface PersonalProjectView {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

export interface CreateThreadInput {
  /** Supplied when a personal row already owns the id. */
  readonly threadId?: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export interface PersonalSendInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly mode: PersonalSendMode;
  readonly titleSeed?: string;
  readonly modelSelection?: ModelSelection;
  readonly context?: OrchestrationMessageContext;
}

export interface PersonalStopInput {
  readonly threadId: ThreadId;
  readonly terminateProcesses: boolean;
}

export interface PersonalUpdateMetaInput {
  readonly threadId: ThreadId;
  readonly title?: string;
  readonly modelSelection?: ModelSelection;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

/**
 * A generated title write that must not overwrite a rename it did not see.
 * The write lands only while the thread still carries `expectedTitle` at
 * `expectedVersion`; otherwise the engine leaves it alone.
 */
export interface PersonalRenameThreadIfUnchangedInput {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly expectedTitle: string;
  readonly expectedVersion: CommandId | null;
}

export interface PersonalPostNoticeInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
}

/**
 * One streamed chunk of a notice, for callers that mirror a reply as it
 * arrives. Reuse `key` when retrying the same chunk so it is written once.
 */
export interface PersonalAppendNoticeInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly delta: string;
  readonly key: string;
  readonly context?: OrchestrationMessageContext;
}

export interface PersonalCompleteNoticeInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/** A user-role message written into a thread with no turn around it. */
export interface PersonalPostUserMessageInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly context?: OrchestrationMessageContext;
}

/** Asks the provider to run the thread's turn again, with no new user message. */
export interface PersonalContinueTurnInput {
  readonly threadId: ThreadId;
  readonly interactionMode: ProviderInteractionMode;
  readonly modelSelection?: ModelSelection;
  readonly systemInstructions?: string;
}

/** The automatic-retry state the chat shows next to a failed reply. */
export interface PersonalProviderRetryMark {
  readonly auto: "pending" | "exhausted";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly retryAt: string | null;
}

export interface PersonalSetProviderRetryInput {
  readonly threadId: ThreadId;
  /** `null` drops the marker, and does nothing when none is set. */
  readonly retry: PersonalProviderRetryMark | null;
}

export interface PersonalEngineShape {
  readonly createProject: (
    input: CreateProjectInput,
  ) => Effect.Effect<ProjectId, PersonalEngineError>;
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<ThreadId, PersonalEngineError>;
  readonly send: (input: PersonalSendInput) => Effect.Effect<void, PersonalEngineError>;
  /**
   * Continues the turn the session already holds. It never posts a message.
   * Adapters that cannot continue without a prompt are sent a short one.
   */
  readonly continueTurn: (
    input: PersonalContinueTurnInput,
  ) => Effect.Effect<void, PersonalEngineError>;
  /** Writes or clears the retry marker on the thread's session. */
  readonly setProviderRetry: (
    input: PersonalSetProviderRetryInput,
  ) => Effect.Effect<void, PersonalEngineError>;
  /** `turnId` pins the interrupt to the turn the caller saw. */
  readonly interrupt: (
    threadId: ThreadId,
    turnId?: TurnId,
  ) => Effect.Effect<void, PersonalEngineError>;
  /**
   * Whether the chat has a running turn that a `steer` send would join now.
   * False while its run is starting, preparing or waiting, when a steer is
   * refused and only a queued send can carry the text.
   */
  readonly canSteer: (threadId: ThreadId) => Effect.Effect<boolean, PersonalEngineError>;
  /**
   * Cancels the chat's queued runs whose user message id starts with
   * `messageIdPrefix`, so a stopped task's queued steer never starts a run.
   * A run that is not queued is left alone.
   */
  readonly cancelQueuedMessages: (input: {
    readonly threadId: ThreadId;
    readonly messageIdPrefix: string;
  }) => Effect.Effect<void, PersonalEngineError>;
  readonly stop: (input: PersonalStopInput) => Effect.Effect<void, PersonalEngineError>;
  readonly archive: (threadId: ThreadId) => Effect.Effect<void, PersonalEngineError>;
  readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void, PersonalEngineError>;
  readonly updateMeta: (input: PersonalUpdateMetaInput) => Effect.Effect<void, PersonalEngineError>;
  /** Rename only if the thread still matches the title and version seen. */
  readonly renameThreadIfUnchanged: (
    input: PersonalRenameThreadIfUnchangedInput,
  ) => Effect.Effect<void, PersonalEngineError>;
  /** Assistant-role notice with no turn around it. */
  readonly postNotice: (input: PersonalPostNoticeInput) => Effect.Effect<void, PersonalEngineError>;
  /** Writes one chunk of a streamed notice. */
  readonly appendNotice: (
    input: PersonalAppendNoticeInput,
  ) => Effect.Effect<void, PersonalEngineError>;
  /** Closes a streamed notice. */
  readonly completeNotice: (
    input: PersonalCompleteNoticeInput,
  ) => Effect.Effect<void, PersonalEngineError>;
  /** Writes a user-role message with no turn, as a group relay does. */
  readonly postUserMessage: (
    input: PersonalPostUserMessageInput,
  ) => Effect.Effect<void, PersonalEngineError>;
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<PersonalThreadView>, PersonalEngineError>;
  readonly getProject: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<PersonalProjectView>, PersonalEngineError>;
  readonly listProjects: () => Effect.Effect<
    ReadonlyArray<PersonalProjectView>,
    PersonalEngineError
  >;
  readonly latestAssistantMessage: (input: {
    readonly threadId: ThreadId;
    readonly after?: DateTime.Utc;
    /** Tie-break for messages written in the same millisecond. */
    readonly afterMessageId?: MessageId;
    /** Restricts the read to one turn. */
    readonly turnId?: TurnId;
  }) => Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError>;
  readonly latestUserMessage: (input: {
    readonly threadId: ThreadId;
    /** Skips the server's own generated messages, which carry this id prefix. */
    readonly excludeIdPrefix?: string;
  }) => Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError>;
  readonly messageById: (
    messageId: MessageId,
  ) => Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError>;
  readonly messagesByIds: (input: {
    readonly threadId: ThreadId;
    readonly messageIds: ReadonlyArray<MessageId>;
  }) => Effect.Effect<ReadonlyArray<PersonalMessageView>, PersonalEngineError>;
  readonly listMessages: (input: {
    readonly threadId: ThreadId;
    readonly limit: number;
    readonly before?: DateTime.Utc;
  }) => Effect.Effect<ReadonlyArray<PersonalMessageView>, PersonalEngineError>;
  /** The latest provider-reported context size for the chat, in tokens. */
  readonly latestContextTokens: (
    threadId: ThreadId,
  ) => Effect.Effect<number | null, PersonalEngineError>;
  /** Whether the provider compacted this chat after `since`. */
  readonly compactedSince: (input: {
    readonly threadId: ThreadId;
    readonly since: string;
  }) => Effect.Effect<boolean, PersonalEngineError>;
  /** Whether any tool step of the chat matches one of the web or browser needles. */
  readonly threadUsedWeb: (input: {
    readonly threadId: ThreadId;
    readonly needles: ReadonlyArray<string>;
  }) => Effect.Effect<boolean, PersonalEngineError>;
  /** The chat's tool steps since `since`, newest first, capped at `limit`. */
  readonly toolStepsSince: (input: {
    readonly threadId: ThreadId;
    readonly since: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<PersonalToolStepView>, PersonalEngineError>;
  /** Activities by id, for the full text behind a chat's previews. */
  readonly activitiesByIds: (input: {
    readonly threadId: ThreadId;
    readonly ids: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<PersonalActivityView>, PersonalEngineError>;
  /** The newest reasoning and tool step of each chat whose bot is running. */
  readonly workingSnapshot: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<PersonalWorkingRow>, PersonalEngineError>;
  readonly liveTaskIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<string>, PersonalEngineError>;
  readonly shellSnapshot: (input: {
    readonly unsettledOnly: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationThreadShellV1Wire>, PersonalEngineError>;
  /** The named chats' shells, read by id instead of scanning every thread. */
  readonly threadShells: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadShellV1Wire>, PersonalEngineError>;
  readonly events: Stream.Stream<PersonalThreadEvent>;
}

export class PersonalEngine extends Context.Service<PersonalEngine, PersonalEngineShape>()(
  "t3/personal/engine/PersonalEngine",
) {}
