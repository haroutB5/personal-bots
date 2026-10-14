import {
  readPersonalFollowUp,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";

import type { ConversationItem } from "./conversationModel";

/** The activity the server appends when the bot's provider takes a message in. */
export const USER_MESSAGE_DELIVERED_KIND = "user-message.delivered";

export type MessageReadStatus = "steering" | "queued" | "read";

export interface LatestMessageReadStatus {
  readonly messageId: string;
  readonly status: MessageReadStatus;
}

function deliveredMessageId(activity: OrchestrationThreadActivity): string | null {
  if (activity.kind !== USER_MESSAGE_DELIVERED_KIND) return null;
  const payload = activity.payload as { messageId?: unknown } | null | undefined;
  return typeof payload?.messageId === "string" ? payload.messageId : null;
}

/**
 * The status under the owner's latest message, or null for none.
 *
 * "Read" rests only on the server's `user-message.delivered` activity for that
 * message, written when the provider actually took it in (Claude's CLI drained
 * it into a turn, Codex started its queued turn, OpenCode accepted it). Nothing
 * the bot says counts: output from the step it was already on proves nothing.
 *
 * "Steering" (or "Queued" for a send that asked to wait) is shown while the
 * bot is busy with a turn that began before the message was sent. Steering is
 * the contract's default: absent `followUp` on `thread.turn.start` means the
 * message folds into the running turn, so only an explicit "Queue after this
 * turn" send carries a marker, and the label says "Queued" only for that one.
 * The marker rides on the message's own `context` (see
 * `PERSONAL_FOLLOW_UP_CONTEXT_KIND`), so a reload and the owner's other devices
 * read the same choice back. A message that starts its own turn shows nothing
 * until it is read (usually a moment), so an idle send goes straight to
 * "Read". A message that never gets read (stopped, or sent before this
 * existed) shows nothing once the bot is idle, rather than a "Queued" that
 * would never clear.
 */
export function deriveLatestMessageReadStatus(input: {
  readonly items: ReadonlyArray<ConversationItem>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly busy: boolean;
  readonly latestTurn: OrchestrationLatestTurn | null;
}): LatestMessageReadStatus | null {
  let latest: Extract<ConversationItem, { kind: "message" }>["message"] | null = null;
  for (let index = input.items.length - 1; index >= 0; index -= 1) {
    const item = input.items[index];
    if (item?.kind === "message" && item.message.role === "user") {
      latest = item.message;
      break;
    }
  }
  if (latest === null) return null;
  const messageId = String(latest.id);

  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.activities[index];
    if (activity !== undefined && deliveredMessageId(activity) === messageId) {
      return { messageId, status: "read" };
    }
  }

  const turn = input.latestTurn;
  const sentMidTurn =
    turn !== null &&
    turn.state === "running" &&
    Date.parse(turn.requestedAt) < Date.parse(latest.createdAt);
  if (!input.busy || !sentMidTurn) return null;
  return {
    messageId,
    status: readPersonalFollowUp(latest.context) === "queue" ? "queued" : "steering",
  };
}
