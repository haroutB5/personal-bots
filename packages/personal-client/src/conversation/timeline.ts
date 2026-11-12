import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";

import type { ChatMessage, ProposedPlan, TimelineEntry, WorkLogEntry } from "./types.ts";
import type { OrchestrationThreadActivity } from "./wireTypes.ts";

/**
 * One ordered timeline from a chat's messages, plans and work rows. A user
 * message that only carries an async answer is dropped when its work row
 * already shows that answer.
 */
export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
  activities: ReadonlyArray<OrchestrationThreadActivity> = [],
): TimelineEntry[] {
  const foldedAnswerMessageIds = new Set(
    workEntries.flatMap((entry) =>
      entry.questionAnswer ? [`async-answer:${entry.questionAnswer.requestId}`] : [],
    ),
  );
  const entries: TimelineEntry[] = [
    ...messages
      .filter((message) => message.role !== "user" || !foldedAnswerMessageIds.has(message.id))
      .map((message): TimelineEntry => ({
        id: message.id,
        kind: "message",
        createdAt: message.createdAt,
        message,
      })),
    ...proposedPlans.map((proposedPlan): TimelineEntry => ({
      id: proposedPlan.id,
      kind: "proposed-plan",
      createdAt: proposedPlan.createdAt,
      proposedPlan,
    })),
    ...workEntries.map((entry): TimelineEntry => ({
      id: entry.id,
      kind: "work",
      createdAt: entry.createdAt,
      entry,
    })),
    ...htmlRenderEntriesFromActivities(activities),
  ];
  return entries.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * The pages a bot showed in this chat. A page is the output of a finished page
 * tool call, which the server sends as a turn item on the activity's payload;
 * it is not a tool step, so it shows whether or not tool steps are on.
 */
export function htmlRenderEntriesFromActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TimelineEntry[] {
  return activities.flatMap((activity): TimelineEntry[] => {
    if (activity.kind !== "dynamic_tool") return [];
    const item = activity.payload;
    if (typeof item !== "object" || item === null) return [];
    const { status, toolName, output } = item as Record<string, unknown>;
    if (status !== "completed") return [];
    if (toolName !== null && toolName !== undefined && typeof toolName !== "string") return [];
    const htmlRender = htmlRenderFromToolItem({ toolName, output });
    return htmlRender === undefined
      ? []
      : [
          {
            id: String(activity.id),
            kind: "html-render",
            createdAt: activity.createdAt,
            htmlRender,
          },
        ];
  });
}

/** The v2 projection has no v1 activity rows for the web yet, so a chat shows no tool steps. */
export function deriveWorkLogEntries(
  _activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  return [];
}
