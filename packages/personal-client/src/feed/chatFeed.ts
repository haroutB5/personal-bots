import type {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
} from "../conversation/wireTypes.ts";

import {
  buildConversationItems,
  type ConversationItem,
} from "../conversation/conversationModel.ts";
import type {
  ChatMessage,
  ProposedPlan,
  TimelineEntry,
  WorkLogEntry,
} from "../conversation/types.ts";

const HIDDEN_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "tool.progress",
  "tool.started",
  "task.updated",
  "context-window.updated",
  "turn.plan.updated",
  "user-message.delivered",
]);

function activityTone(activity: OrchestrationThreadActivity): WorkLogEntry["tone"] {
  if (activity.tone === "error") return "error";
  if (activity.tone === "tool") return "tool";
  return "info";
}

function activityLabel(activity: OrchestrationThreadActivity): string {
  const summary = activity.summary.trim();
  return summary.length > 0 ? summary : activity.kind;
}

/**
 * The work rows shown when Settings > Chat > "Show tool steps" is on. The web
 * builds these with the full session-logic projection; a bot chat only needs
 * the row's words, time, tone and kind, which the server already sends on the
 * activity. Both clients read the same activity shape.
 */
export function workEntriesFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  return activities
    .filter(
      (activity) =>
        !HIDDEN_ACTIVITY_KINDS.has(activity.kind) &&
        !activity.kind.startsWith("checkpoint.") &&
        activity.summary !== "Checkpoint captured",
    )
    .map((activity) => ({
      id: activity.id,
      createdAt: activity.createdAt,
      label: activityLabel(activity),
      tone: activityTone(activity),
      sourceActivityKind: activity.kind,
      ...(activity.turnId === null ? {} : { turnId: activity.turnId }),
    }));
}

function messageEntries(messages: ReadonlyArray<OrchestrationMessage>): TimelineEntry[] {
  return messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message: message as ChatMessage,
  }));
}

function planEntries(plans: ReadonlyArray<OrchestrationProposedPlan>): TimelineEntry[] {
  return plans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan: proposedPlan as ProposedPlan,
  }));
}

function workTimelineEntries(entries: ReadonlyArray<WorkLogEntry>): TimelineEntry[] {
  return entries.map((entry) => ({
    id: `work:${entry.id}`,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
}

export interface ChatFeedInput {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly showToolSteps?: boolean;
  readonly groups?: boolean;
}

/**
 * The transcript rows for one chat. The message, plan and work streams become
 * one ordered timeline, then the shared conversation model adds day dividers
 * and groups work steps exactly as it does on the web.
 */
export function buildChatFeed(input: ChatFeedInput): ConversationItem[] {
  const work = input.showToolSteps === true ? workEntriesFromActivities(input.activities) : [];
  const entries = [
    ...messageEntries(input.messages),
    ...planEntries(input.proposedPlans),
    ...workTimelineEntries(work),
  ].toSorted((left, right) => {
    const leftAt = Date.parse(left.createdAt);
    const rightAt = Date.parse(right.createdAt);
    if (leftAt === rightAt) return 0;
    return leftAt < rightAt ? -1 : 1;
  });
  return buildConversationItems(entries, {
    showToolSteps: input.showToolSteps === true,
    ...(input.groups === true ? { groups: true } : {}),
  });
}
