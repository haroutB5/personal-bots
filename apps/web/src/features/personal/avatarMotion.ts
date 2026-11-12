import {
  isContinuousMotion,
  type AvatarMotion,
} from "@hbots/personal-client/bots/avatarMotionState";

export {
  AVATAR_MOTIONS,
  isContinuousMotion,
  motionForConversationState,
  type AvatarMotion,
} from "@hbots/personal-client/bots/avatarMotionState";

/** The shape of {@link import("./botSummaries").BotSummary} the mapping reads. */
export interface BotMotionInput {
  readonly live: boolean;
  /** Live, but no linked turn has produced a reply yet (`isBotThinking`). */
  readonly thinking?: boolean | undefined;
  readonly rateLimited: boolean;
  /** A linked chat's last reply failed (`BotSummary.erroredThread`). */
  readonly erroredThread?: unknown;
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
  if (summary.attentionThreads.length > 0) return "waiting";
  // A failed reply, like the header's "Error": blocked until it is sent again.
  if (summary.erroredThread != null) return "blocked";
  if (summary.waitingFor !== null) return "waiting";
  return "idle";
}

/**
 * The pre-1.49.0 list rule, kept behind the `all-busy-motion` kill switch
 * (`perfFlags.ts`): the first thinking or working avatar keeps moving and
 * later ones rest; their green dots still say they are busy.
 */
export function firstContinuousMotionOnly(motions: ReadonlyArray<AvatarMotion>): AvatarMotion[] {
  let seen = false;
  return motions.map((motion) => {
    if (!isContinuousMotion(motion)) return motion;
    if (seen) return "idle";
    seen = true;
    return motion;
  });
}

/**
 * Which rows of a list draw the working comet: every `working` one, or, with
 * `onlyFirst` (the `anim-all` kill switch), the first one only, or none.
 * Since 1.57.3 the comet is built from compositor-only layers
 * (`avatarComet.ts`), so every busy bot gets it without costing the main
 * thread anything; until 1.56 it repainted per frame and stayed on one row
 * (five of them dropped /bots to ~22 fps at 4x CPU).
 */
export function cometRowIndexes(
  motions: ReadonlyArray<AvatarMotion | undefined>,
  onlyFirst = false,
): number[] {
  const rows = motions.flatMap((motion, index) => (motion === "working" ? [index] : []));
  return onlyFirst ? rows.slice(0, 1) : rows;
}
