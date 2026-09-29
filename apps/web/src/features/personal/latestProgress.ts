import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  OrchestrationMessage,
} from "@t3tools/contracts";
import { pickProgressNote, toolStepNoteText } from "@t3tools/contracts";

/**
 * The newest short progress note of the turn that is running: its latest
 * reasoning / thinking message, or the title of its latest tool step, whichever
 * is newer (see `pickProgressNote`). Read from what the open chat already
 * holds; nothing here fetches, and nothing but a reasoning message's text and
 * a tool step's title is ever read (never tool output, arguments or detail).
 *
 * Null when no turn is running, or when the running turn has said nothing yet.
 * `working` is the caller's word for "a turn is running": the note is only
 * meant for that time.
 */
export function deriveLatestProgressNote(input: {
  readonly working: boolean;
  readonly messages: ReadonlyArray<
    Pick<OrchestrationMessage, "role" | "text" | "createdAt"> & {
      readonly updatedAt?: string | undefined;
    }
  >;
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "kind" | "summary" | "payload" | "createdAt">
  >;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "requestedAt"> | null;
}): string | null {
  if (!input.working || input.latestTurn === null) return null;
  const since = Date.parse(input.latestTurn.requestedAt);
  const isCurrent = (at: string) => !Number.isFinite(since) || Date.parse(at) >= since;

  let reasoning: { text: string; at: string } | null = null;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined || message.role !== "reasoning") continue;
    if (!isCurrent(message.createdAt)) break;
    if (message.text.trim().length === 0) continue;
    reasoning = { text: message.text, at: message.updatedAt ?? message.createdAt };
    break;
  }

  let tool: { text: string; at: string } | null = null;
  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.activities[index];
    if (activity === undefined || !activity.kind.startsWith("tool.")) continue;
    if (!isCurrent(activity.createdAt)) break;
    const title = toolStepTitle(activity);
    if (title === null) continue;
    tool = { text: title, at: activity.createdAt };
    break;
  }

  return pickProgressNote({ reasoning, tool });
}

/** A tool step's title: the payload's `title`, else its summary without the "started" tail. */
export function toolStepTitle(
  activity: Pick<OrchestrationThreadActivity, "summary" | "payload">,
): string | null {
  const payload = activity.payload;
  const title =
    typeof payload === "object" && payload !== null && "title" in payload
      ? (payload as { readonly title?: unknown }).title
      : undefined;
  return toolStepNoteText(title, activity.summary);
}
