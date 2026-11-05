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

export type PersonalThreadStatus = "idle" | "starting" | "running" | "waiting" | "error";

export type PersonalThreadEvent =
  | {
      readonly _tag: "TurnStartRequested";
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }
  | {
      readonly _tag: "MessageSent";
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly role: "user" | "assistant";
    }
  | {
      readonly _tag: "TurnEnded";
      readonly threadId: ThreadId;
      readonly outcome: PersonalTurnOutcome;
    }
  | {
      readonly _tag: "StatusChanged";
      readonly threadId: ThreadId;
      readonly status: PersonalThreadStatus;
    }
  | { readonly _tag: "ThreadArchived"; readonly threadId: ThreadId }
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

export interface PersonalPostNoticeInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
}

export interface PersonalEngineShape {
  readonly createProject: (
    input: CreateProjectInput,
  ) => Effect.Effect<ProjectId, PersonalEngineError>;
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<ThreadId, PersonalEngineError>;
  readonly send: (input: PersonalSendInput) => Effect.Effect<void, PersonalEngineError>;
  readonly interrupt: (threadId: ThreadId) => Effect.Effect<void, PersonalEngineError>;
  readonly stop: (input: PersonalStopInput) => Effect.Effect<void, PersonalEngineError>;
  readonly archive: (threadId: ThreadId) => Effect.Effect<void, PersonalEngineError>;
  readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void, PersonalEngineError>;
  readonly updateMeta: (input: PersonalUpdateMetaInput) => Effect.Effect<void, PersonalEngineError>;
  /** Assistant-role notice with no turn around it. */
  readonly postNotice: (input: PersonalPostNoticeInput) => Effect.Effect<void, PersonalEngineError>;
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<PersonalThreadView>, PersonalEngineError>;
  readonly latestAssistantMessage: (input: {
    readonly threadId: ThreadId;
    readonly after?: DateTime.Utc;
  }) => Effect.Effect<Option.Option<PersonalMessageView>, PersonalEngineError>;
  readonly listMessages: (input: {
    readonly threadId: ThreadId;
    readonly limit: number;
    readonly before?: DateTime.Utc;
  }) => Effect.Effect<ReadonlyArray<PersonalMessageView>, PersonalEngineError>;
  readonly liveTaskIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<string>, PersonalEngineError>;
  readonly shellSnapshot: (input: {
    readonly unsettledOnly: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationThreadShellV1Wire>, PersonalEngineError>;
  readonly events: Stream.Stream<PersonalThreadEvent>;
}

export class PersonalEngine extends Context.Service<PersonalEngine, PersonalEngineShape>()(
  "t3/personal/engine/PersonalEngine",
) {}
