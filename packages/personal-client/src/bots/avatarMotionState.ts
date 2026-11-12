import type { ConversationState } from "../conversation/conversationModel.ts";

/** Only `thinking` and `working` loop; the rest play once and hold. Status dots stay the accessible channel. */
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

/** Motions that loop for as long as they last (and pause while off screen). */
export function isContinuousMotion(motion: AvatarMotion): boolean {
  return motion === "thinking" || motion === "working";
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
