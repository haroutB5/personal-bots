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
  ];
  return entries.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** The v2 projection has no v1 activity rows for the web yet, so a chat shows no tool steps. */
export function deriveWorkLogEntries(
  _activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  return [];
}
