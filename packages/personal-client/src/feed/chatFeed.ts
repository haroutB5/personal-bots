import type {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
} from "../conversation/wireTypes.ts";

import {
  buildConversationItems,
  type ConversationItem,
} from "../conversation/conversationModel.ts";
import { htmlRenderEntriesFromActivities } from "../conversation/timeline.ts";
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

const MESSAGE_ENTRY_CACHE = new WeakMap<OrchestrationMessage, TimelineEntry>();

function messageEntry(message: OrchestrationMessage): TimelineEntry {
  let cached = MESSAGE_ENTRY_CACHE.get(message);
  if (cached === undefined) {
    cached = {
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message: message as ChatMessage,
    };
    MESSAGE_ENTRY_CACHE.set(message, cached);
  }
  return cached;
}

function sortTimelineEntries(raw: ReadonlyArray<TimelineEntry>): ReadonlyArray<TimelineEntry> {
  const length = raw.length;
  if (length <= 1) return raw;
  const times = new Array<number>(length);
  let monotonic = true;
  let prev = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < length; i += 1) {
    const at = Date.parse(raw[i]!.createdAt);
    times[i] = at;
    if (Number.isNaN(at) || at < prev) {
      monotonic = false;
    } else {
      prev = at;
    }
  }
  if (monotonic) return raw;
  const indices = new Array<number>(length);
  for (let i = 0; i < length; i += 1) indices[i] = i;
  indices.sort((left, right) => {
    const leftAt = times[left]!;
    const rightAt = times[right]!;
    if (leftAt === rightAt) return 0;
    return leftAt < rightAt ? -1 : 1;
  });
  const sorted = new Array<TimelineEntry>(length);
  for (let i = 0; i < length; i += 1) sorted[i] = raw[indices[i]!]!;
  return sorted;
}

/**
 * The transcript rows for one chat. The message, plan and work streams become
 * one ordered timeline, then the shared conversation model adds day dividers
 * and groups work steps exactly as it does on the web.
 */
export function buildChatFeed(input: ChatFeedInput): ConversationItem[] {
  const raw: TimelineEntry[] = [];
  for (const message of input.messages) raw.push(messageEntry(message));
  if (input.proposedPlans.length > 0) {
    for (const entry of planEntries(input.proposedPlans)) raw.push(entry);
  }
  if (input.showToolSteps === true) {
    for (const entry of workTimelineEntries(workEntriesFromActivities(input.activities))) {
      raw.push(entry);
    }
  }
  if (input.activities.length > 0) {
    for (const entry of htmlRenderEntriesFromActivities(input.activities)) raw.push(entry);
  }
  const entries = sortTimelineEntries(raw);
  return buildConversationItems(entries, {
    showToolSteps: input.showToolSteps === true,
    ...(input.groups === true ? { groups: true } : {}),
  });
}
