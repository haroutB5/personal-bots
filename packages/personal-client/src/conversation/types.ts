import type { PendingApproval } from "@t3tools/client-runtime/pending-requests";
import type { WorkLogToolLifecycleStatus } from "@t3tools/client-runtime/work-log/presentation";
import type {
  ChatAttachment,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  ToolActivityIcon,
  ToolActivitySource,
  ToolActivitySurface,
  ToolLifecycleItemType,
  TurnId,
  UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";

/**
 * Structural copies of the web app's chat types. The package cannot import
 * `~/types` or `~/session-logic`, and the phone must read the same shapes the
 * server already sends. The web app's type test asserts its own types are
 * assignable to these, so upstream drift fails the web typecheck.
 */
export interface ChatMessage extends Omit<OrchestrationMessage, "attachments"> {
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}

export type ProposedPlan = OrchestrationProposedPlan;

export interface WorkLogEntry {
  questionAnswer?: UserInputAttachmentAnswerPayload;
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  /** Stable provider identity across in-progress and completed lifecycle updates. */
  toolCallId?: string;
  label: string;
  detail?: string;
  viewedImagePath?: string;
  command?: string;
  rawCommand?: string;
  /**
   * The activity whose `command` a chat open cut to a preview
   * (`data.commandTruncated`); `withFullToolCommand` swaps in the whole one.
   */
  commandPreviewOf?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolSurface?: ToolActivitySurface;
  toolIcon?: ToolActivityIcon;
  toolSource?: ToolActivitySource;
  toolData?: unknown;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  /** From runtime item / task payload `status` when present (e.g. tool.updated). */
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  /** Originating orchestration activity kind (e.g. `user-input.requested`) for row chrome. */
  sourceActivityKind?: OrchestrationThreadActivity["kind"];
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
  /** Agent role (subagent_type) for labeled timeline rows. */
  agentRole?: string;
  /**
   * Present on agent-spawn rows: one per workflow run or per-turn batch of
   * direct spawns. The row ("Kicked off N subagents") derives its live
   * status and member list from the agent panel model at render time.
   */
  agentSpawn?: {
    /** Workflow coordinator taskId, or null for a direct-spawn batch. */
    workflowId: string | null;
    agentTaskIds: ReadonlyArray<string>;
  };
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };
