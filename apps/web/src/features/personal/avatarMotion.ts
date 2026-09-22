import type { ConversationState } from "./conversationModel";

/**
 * How a bot avatar carries its state.
 *
 * Only `thinking` and `working` are continuous loops; everything else is a
 * one-shot transition into a held pose, and `idle` is the plain rest pose. The
 * poses are authored in `avatarRemotion/avatarStates.ts` and shipped as the
 * generated keyframes in `avatarMotion.generated.css`. The status dots stay the
 * accessible channel; motion is decoration on top of them.
 */
export type AvatarMotion = "idle" | "thinking" | "working" | "waiting" | "blocked" | "done";

/** Every motion, in preview order (the Studio and the keyframe generator use it). */
export const AVATAR_MOTIONS: readonly AvatarMotion[] = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
  "done",
];

/** Motions that loop for as long as they last (and so count against the cap). */
export function isContinuousMotion(motion: AvatarMotion): boolean {
  return motion === "thinking" || motion === "working";
}

/**
 * How many avatars may run a continuous animation at once in one list. Ten
 * bobbing avatars is exactly the kind of permanent repaint that pegs the GPU on
 * a high-refresh display, so the list animates the first busy bot only.
 */
export const MAX_CONTINUOUS_MOTION = 1;

/** The shape of {@link import("./botSummaries").BotSummary} the mapping reads. */
export interface BotMotionInput {
  readonly live: boolean;
  /** Live, but no linked turn has produced a reply yet (`isBotThinking`). */
  readonly thinking?: boolean | undefined;
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
  if (summary.live) return summary.thinking === true ? "thinking" : "working";
  if (summary.rateLimited) return "blocked";
  if (summary.attentionThreads.length > 0 || summary.waitingFor !== null) return "waiting";
  return "idle";
}

/**
 * Conversation-header motion, mirroring the header dot's grouping. `thinking`
 * refines a working turn that has not produced anything yet
 * (`isTurnThinking`).
 */
export function motionForConversationState(
  state: ConversationState,
  thinking = false,
): AvatarMotion {
  switch (state) {
    case "working":
      return thinking ? "thinking" : "working";
    case "waiting":
    case "needs_help":
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
 * Cap the continuous animation across a list: the first thinking or working
 * avatar keeps moving, later ones fall back to the static idle pose. They are
 * still marked as busy by their green dot, which is the channel that matters.
 */
export function capContinuousMotion(motions: ReadonlyArray<AvatarMotion>): AvatarMotion[] {
  let allowed = MAX_CONTINUOUS_MOTION;
  return motions.map((motion) => {
    if (!isContinuousMotion(motion)) return motion;
    if (allowed <= 0) return "idle";
    allowed -= 1;
    return motion;
  });
}
