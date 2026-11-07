import { readPersonalFollowUp } from "@t3tools/contracts";
import type { OrchestrationLatestTurn } from "../bots/threadShell.ts";
import type { OrchestrationThreadActivity } from "../conversation/wireTypes.ts";

import type { ConversationItem } from "../conversation/conversationModel.ts";

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
 * "Read" rests only on the server's `user-message.delivered` activity for that
 * message, written when the provider actually took it in (Claude's CLI drained
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
