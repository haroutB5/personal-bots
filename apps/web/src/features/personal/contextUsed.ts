import type { PersonalMemoryFeedbackSignal, PersonalMemoryTurnContext } from "@t3tools/contracts";

import type { ConversationItem } from "./conversationModel";

/** Where a turn's app was found, in words. */
export function viaLabel(via: string): string {
  switch (via) {
    case "title":
      return "chat title";
    case "message":
      return "this message";
    case "recent":
      return "recent messages";
    case "role":
      return "the bot's role";
    case "earlier":
      return "earlier in this chat";
    default:
      return via;
  }
}

/** "Matchday · chat title, recent messages". */
export function appChipLabel(app: PersonalMemoryTurnContext["apps"][number]): string {
  return app.via.length === 0 ? app.label : `${app.label} · ${app.via.map(viaLabel).join(", ")}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The collapsed line: "34 rules · 6 notes and summaries · 2 left out". */
export function contextUsedSummary(context: PersonalMemoryTurnContext): string {
  const parts = [
    plural(context.rules.items.length, "rule", "rules"),
    plural(context.notes.length, "note or summary", "notes and summaries"),
  ];
  const left = context.leftOut.length + context.rules.leftOut.length;
  if (left > 0) parts.push(`${left} left out`);
  return parts.join(" · ");
}

/** What the rules section says about how the rules reached the bot. */
export function rulesHeadline(rules: PersonalMemoryTurnContext["rules"]): string {
  const count = plural(rules.items.length, "rule", "rules");
  if (rules.items.length === 0) return "No rules applied.";
  if (!rules.sent) return `The ${count} listed earlier in this chat still applied.`;
  return `${count} listed with this turn.`;
}

/** What pressing a mark does: the same mark again takes it back. */
export function nextFeedback(
  current: PersonalMemoryFeedbackSignal | null,
  pressed: PersonalMemoryFeedbackSignal,
): PersonalMemoryFeedbackSignal | "clear" {
  return current === pressed ? "clear" : pressed;
}

/** How a mark reads next to the entry. */
export function feedbackLabel(signal: PersonalMemoryFeedbackSignal): string {
  return signal === "outdated" ? "Marked outdated" : "Marked not relevant";
}

/** A turn's trace is kept this long (the server clears older ones): older replies show no line. */
export const CONTEXT_USED_KEEP_DAYS = 14;

/** Whether a reply is recent enough to still have a recorded turn. */
export function hasRecordedContext(replyAt: Date, now: Date): boolean {
  return now.getTime() - replyAt.getTime() < CONTEXT_USED_KEEP_DAYS * 86_400_000;
}

/** The note kind in words. */
export function noteKindLabel(kind: string): string {
  return kind === "task_summary" ? "Task summary" : kind === "preference" ? "Rule" : "Note";
}

/**
 * The turn each assistant message belongs to, for the messages that end one:
 * assistant message item id to the id of the message that started its turn
 * (the owner's message, or a task, routine or notice turn the app wrote). Only
 * the last assistant message of a turn gets one, so the view shows once per turn.
 */
export function turnStartByAssistantItem(
  items: ReadonlyArray<ConversationItem>,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let starter: string | null = null;
  let lastAssistantItem: string | null = null;
  const close = () => {
    if (starter !== null && lastAssistantItem !== null) result.set(lastAssistantItem, starter);
    lastAssistantItem = null;
  };
  for (const item of items) {
    if (item.kind === "message" && item.message.role === "assistant") {
      lastAssistantItem = item.id;
      continue;
    }
    const startsTurn =
      (item.kind === "message" && item.message.role === "user") ||
      item.kind === "system-turn" ||
      item.kind === "notice";
    if (startsTurn) {
      close();
      starter = String(item.message.id);
    }
  }
  close();
  return result;
}
