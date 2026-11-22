import type { ProviderRequestKind } from "@t3tools/contracts";
import {
  derivePendingThreadRequests,
  type ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";

import type { QuestionProjection } from "./questionCards.ts";

/**
 * A pending tool call the agent's CLI stopped to ask about. Only pending ones are
 * cards, so the chat and the list's "Needs approval" always agree.
 */
export interface ToolApprovalCardItem {
  readonly requestId: string;
  readonly createdAt: string;
  readonly requestKind: ProviderRequestKind;
  /** What the tool would do, usually the full command line. */
  readonly detail: string | null;
  /** The CLI's own reason, when it gives one. */
  readonly reason: string | null;
  readonly appName: string | null;
  /** False when the provider can no longer take an answer (a restarted session). */
  readonly answerable: boolean;
  readonly supportsFeedback: boolean;
}

const TOOL_LABEL: Record<ProviderRequestKind, string> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change a file",
  "mcp-elicitation": "Connector request",
  permission: "Permission change",
};

/** The card's one-line tool label, e.g. "Run a command". */
export function toolApprovalLabel(card: Pick<ToolApprovalCardItem, "requestKind" | "appName">) {
  const base = TOOL_LABEL[card.requestKind] ?? "Use a tool";
  return card.appName === null ? base : `${base} (${card.appName})`;
}

/** Commands longer than this start collapsed, with a "Show all" toggle. */
export const TOOL_APPROVAL_PREVIEW_CHARS = 240;

/** The collapsed preview of a long command, or the whole text when it is short. */
export function toolApprovalPreview(
  detail: string,
  expanded: boolean,
): { readonly text: string; readonly truncated: boolean } {
  if (expanded || detail.length <= TOOL_APPROVAL_PREVIEW_CHARS) {
    return { text: detail, truncated: false };
  }
  return { text: `${detail.slice(0, TOOL_APPROVAL_PREVIEW_CHARS).trimEnd()}…`, truncated: true };
}

export function toolApprovalCardFromPending(approval: ThreadPendingApproval): ToolApprovalCardItem {
  const detail = approval.detail?.trim() ?? "";
  const reason = approval.reason?.trim() ?? "";
  return {
    requestId: String(approval.requestId),
    createdAt: approval.createdAt,
    requestKind: approval.requestKind,
    detail: detail === "" ? null : detail,
    reason: reason === "" || reason === detail ? null : reason,
    appName: approval.appName ?? null,
    answerable: approval.responseCapability === "live",
    supportsFeedback: approval.supportsFeedback === true,
  };
}

/** Every approval this chat's projection is still waiting on, oldest first. */
export function deriveToolApprovalCards(
  projection: Pick<QuestionProjection, "runtimeRequests" | "turnItems"> | null,
): ReadonlyArray<ToolApprovalCardItem> {
  if (projection === null) return [];
  return derivePendingThreadRequests(projection)
    .approvals.map(toolApprovalCardFromPending)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** The feed row id of a tool-approval card, used to scroll the chat to it. */
export const toolApprovalCardItemId = (requestId: string): string => `tool-approval:${requestId}`;
