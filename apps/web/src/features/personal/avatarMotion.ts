import type { ConversationState } from "./conversationModel";

/**
 * How a bot avatar carries its state.
 *
 * Only `working` is continuous (a ≤2px bob); everything else is a one-shot
 * transition into a static pose. The status dots stay the accessible channel —
 * motion is decoration on top of them.
 */
export type AvatarMotion = "idle" | "working" | "waiting" | "blocked" | "done";

/**
 * How many avatars may run the continuous animation at once in one list. Ten
 * bobbing avatars is exactly the kind of permanent repaint that pegs the GPU on
 * a high-refresh display, so the list animates the first working bot only.
 */
export const MAX_CONTINUOUS_MOTION = 1;

/** The shape of {@link import("./botSummaries").BotSummary} the mapping reads. */
export interface BotMotionInput {
  readonly live: boolean;
  readonly rateLimited: boolean;
  readonly attentionThreads: ReadonlyArray<unknown>;
  readonly waitingFor: string | null;
}

/**
 * Chats-row motion. Precedence matches the row's status dot (live wins over a
 * rate limit, which wins over a waiting label) so the pose can never contradict
 * the text beside it.
 */
export function motionForSummary(summary: BotMotionInput): AvatarMotion {
  if (summary.live) return "working";
  if (summary.rateLimited) return "blocked";
  if (summary.attentionThreads.length > 0 || summary.waitingFor !== null) return "waiting";
  return "idle";
}

/** Conversation-header motion, mirroring the header dot's grouping. */
export function motionForConversationState(state: ConversationState): AvatarMotion {
  switch (state) {
    case "working":
      return "working";
    case "waiting":
    case "delegating":
      return "waiting";
    case "rate_limited":
    case "retrying":
    case "error":
      return "blocked";
    case "idle":
      return "idle";
  }
}

/**
 * Cap the continuous animation across a list: the first working avatar keeps
 * bobbing, later ones fall back to the static idle pose. They are still marked
 * as working by their green dot, which is the channel that matters.
 */
export function capContinuousMotion(motions: ReadonlyArray<AvatarMotion>): AvatarMotion[] {
  let allowed = MAX_CONTINUOUS_MOTION;
  return motions.map((motion) => {
    if (motion !== "working") return motion;
    if (allowed <= 0) return "idle";
    allowed -= 1;
    return "working";
  });
}
