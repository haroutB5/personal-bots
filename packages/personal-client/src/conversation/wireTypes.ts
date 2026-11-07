import type {
  ApprovalRequestId,
  ChatAttachment,
  EventId,
  IsoDateTime,
  MessageId,
  OrchestrationMessageContext,
  OrchestrationMessageRole,
  ProviderApprovalOption,
  ProviderRequestKind,
  ThreadId,
  TurnId,
  UserInputQuestion,
} from "@t3tools/contracts";

/**
 * The thread, message and request shapes the personal RPCs still send. The
 * bots surfaces own these copies so they do not reach into the client-runtime
 * pending-requests or orchestration shell modules, which follow the v2 shell.
 */
export type ThreadTurnFollowUp = "steer" | "queue";

export interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
}

export interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  /** Async questions can be dismissed without a reply; native callbacks cannot. */
  readonly dismissible: boolean;
}

export interface OrchestrationMessage {
  readonly id: MessageId;
  readonly role: OrchestrationMessageRole;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly turnId: TurnId | null;
  readonly streaming: boolean;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  /** Set when a thread read sent only a preview of `text`. */
  readonly textTruncated?: boolean;
}

export interface OrchestrationProposedPlan {
  readonly id: string;
  readonly turnId: TurnId | null;
  readonly planMarkdown: string;
  readonly implementedAt: IsoDateTime | null;
  readonly implementationThreadId: ThreadId | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface OrchestrationThreadActivity {
  readonly id: EventId;
  readonly tone: "info" | "tool" | "approval" | "error";
  readonly kind: string;
  readonly summary: string;
  readonly payload: unknown;
  readonly turnId: TurnId | null;
  readonly sequence?: number | undefined;
  readonly createdAt: IsoDateTime;
}
