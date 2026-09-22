import type { AvatarMotion } from "../avatarMotion";

/**
 * Remotion avatar states. The CSS pose system's {@link AvatarMotion} plus
 * `thinking`, which has no data source yet (phase B maps it; see
 * `personal-bots-notes/remotion-avatars/PHASE-A.md`).
 *
 * This module must not import `remotion`: the wrapper reads it on every
 * screen, and the Remotion runtime is only fetched when a Player is needed.
 */
export type AvatarAnimState = AvatarMotion | "thinking";

export const AVATAR_ANIM_STATES: readonly AvatarAnimState[] = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
  "done",
];

/** States whose Remotion composition repeats forever. */
export function isContinuousAvatarState(state: AvatarAnimState): boolean {
  return state === "thinking" || state === "working";
}

/**
 * `static`: the plain BotAvatar SVG, no Player mounted.
 * `loop`: a looping Player (thinking/working).
 * `once`: a one-shot Player that swaps itself for a static final pose when done.
 */
export type AvatarPlayerMode = "static" | "loop" | "once";

export interface AvatarPlayerModeInput {
  readonly state: AvatarAnimState;
  readonly reducedMotion: boolean;
  readonly documentHidden: boolean;
  /**
   * Whether this avatar holds the list's continuous-motion slot
   * (`capContinuousMotion`). Headers and single avatars pass true.
   */
  readonly continuousAllowed: boolean;
}

/**
 * The guardrails in one place. Idle, reduced motion and a hidden document are
 * always static; a looping state without the list's single continuous slot is
 * static too, so a list never runs more than one looping Player.
 */
export function avatarPlayerMode(input: AvatarPlayerModeInput): AvatarPlayerMode {
  if (input.reducedMotion || input.documentHidden) return "static";
  if (input.state === "idle") return "static";
  if (isContinuousAvatarState(input.state)) {
    return input.continuousAllowed ? "loop" : "static";
  }
  return "once";
}

/**
 * The CSS pose the static fallback shows for a state. Thinking has no CSS
 * pose, and a looping state that lost its continuous slot must not bob via
 * CSS instead, so both fall back to idle.
 */
export function staticMotionFor(state: AvatarAnimState, continuousAllowed: boolean): AvatarMotion {
  if (state === "thinking") return "idle";
  if (state === "working" && !continuousAllowed) return "idle";
  return state;
}
