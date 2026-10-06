/**
 * Whether a Claude task is really finished when its turn ends. Claude Code
 * lets a turn end while commands it started in the background run on, then
 * runs a new turn by itself when they finish, and the bot's report is in that
 * turn. This is the state machine for that wait, as pure functions: the task
 * service keeps one {@link BackgroundWait} per provider thread with an active
 * attempt and feeds it what the session and the liveness registry say.
 */

/**
 * How long a Claude task stays running after its latest turn ends while
 * background work that turn left (a Bash run with run_in_background, a
 * background subagent, a Monitor) is still live. Claude Code starts a new
 * turn in the same session when that work finishes. The result keeps the
 * earlier turns' replies and appends each follow-up reply after a marker, so
 * a short "nothing pending" follow-up never replaces the real report; while
 * the task waits, the replies so far show on the task as a preview marked
 * `waitingOnBackgroundSince`. Work that never ends (a dev server) closes the
 * task with those replies and a note once no turn has run for this long.
 */
export const PERSONAL_TASK_BACKGROUND_WAIT_MS = 20 * 60_000;

/**
 * Once the background work has ended, how long to wait for the turn Claude
 * Code starts to report it before the latest reply stands as the result.
 */
export const PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS = 60_000;

/** Only Claude sessions run a new turn of their own when background work ends. */
export const BACKGROUND_WAIT_PROVIDER = "claudeAgent";

/** What an active attempt knows about the background work in its chat. */
export interface BackgroundWait {
  readonly attemptKey: string;
  /** Tasks already live when the attempt started; never waited for. */
  readonly baseline: ReadonlySet<string>;
  /** `updatedAt` of the last ended turn that left work running; null = never. */
  readonly pendingReadyAt: string | null;
  /** Since when nothing has run while that work stayed live, epoch ms. */
  readonly idleSinceMs: number;
  /** When the work was first seen ended with no newer turn after it, epoch ms. */
  readonly clearedAtMs: number | null;
  /** ISO time the first turn that left work running ended; null = never. */
  readonly waitingSince: string | null;
  /** Replies of the turns that ended with work left, oldest first. */
  readonly replies: ReadonlyArray<{ readonly messageId: string; readonly text: string }>;
}

/** One attempt of one task; the key a wait belongs to. */
export const backgroundAttemptKey = (attempt: {
  readonly taskId: string;
  readonly attempt: number;
}) => `${attempt.taskId}:${attempt.attempt}`;

/** The wait of an attempt that has seen no background work yet. */
export const newBackgroundWait = (
  attemptKey: string,
  baseline: ReadonlySet<string> = new Set(),
): BackgroundWait => ({
  attemptKey,
  baseline,
  pendingReadyAt: null,
  idleSinceMs: 0,
  clearedAtMs: null,
  waitingSince: null,
  replies: [],
});

/** The newest reply of the ended turn, as the task service reads it from the thread. */
export interface BackgroundReply {
  readonly messageId: string;
  readonly text: string;
}

export interface BackgroundStepInput {
  /** Background tasks live in the chat that this attempt did not start with (Claude only; else empty). */
  readonly pending: ReadonlyArray<string>;
  /** `updatedAt` of the session whose turn just ended. */
  readonly sessionUpdatedAt: string;
  readonly nowMs: number;
  readonly last: BackgroundReply | undefined;
}

export type BackgroundStep = {
  readonly state: BackgroundWait;
} & (
  | {
      /** Keep the attempt open. */
      readonly kind: "wait";
      /** The wait just began: say so once. */
      readonly started: boolean;
      /** This turn's reply was just held: show the replies so far on the task. */
      readonly publishPreview: boolean;
    }
  | {
      /** End the attempt now: `capped` = the wait ran out with work still live. */
      readonly kind: "finish";
      readonly capped: boolean;
    }
);

/**
 * Advances the wait by one ended turn.
 *
 * With background work still live the turn's reply is held and the attempt
 * waits, until nothing has run for {@link PERSONAL_TASK_BACKGROUND_WAIT_MS}.
 * With none live, a task that never waited ends as it always has; a task that
 * waited ends on the next turn that follows the one that left the work, or
 * after {@link PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS} of waiting for that turn.
 */
export const stepBackgroundWait = (
  current: BackgroundWait,
  input: BackgroundStepInput,
): BackgroundStep => {
  let pendingReadyAt = current.pendingReadyAt;
  let idleSinceMs = current.idleSinceMs;
  let clearedAtMs = current.clearedAtMs;
  let waitingSince = current.waitingSince;
  let replies = current.replies;
  const { nowMs } = input;
  const done = (): BackgroundWait => ({
    ...current,
    pendingReadyAt,
    idleSinceMs,
    clearedAtMs,
    waitingSince,
    replies,
  });

  if (input.pending.length > 0) {
    let started = false;
    if (pendingReadyAt !== input.sessionUpdatedAt) {
      if (pendingReadyAt === null) {
        started = true;
        waitingSince = input.sessionUpdatedAt;
      }
      pendingReadyAt = input.sessionUpdatedAt;
      const endedMs = Date.parse(input.sessionUpdatedAt);
      idleSinceMs = Number.isFinite(endedMs) ? Math.min(endedMs, nowMs) : nowMs;
    }
    clearedAtMs = null;
    // This turn's reply is held before anything else, so no later turn, cap
    // or session end can replace it.
    const last = input.last;
    const reply =
      last !== undefined &&
      last.text.trim().length > 0 &&
      !replies.some((held) => held.messageId === last.messageId)
        ? last
        : undefined;
    if (reply !== undefined) {
      replies = [...replies, { messageId: reply.messageId, text: reply.text }];
    }
    if (nowMs - idleSinceMs < PERSONAL_TASK_BACKGROUND_WAIT_MS) {
      return {
        kind: "wait",
        started,
        publishPreview: reply !== undefined,
        state: done(),
      };
    }
    return { kind: "finish", capped: true, state: done() };
  }
  // Never waited: the turn ends the task exactly as it always has.
  if (pendingReadyAt === null) return { kind: "finish", capped: false, state: done() };
  // A turn ended after the one that left the work: its reply is the result.
  if (input.sessionUpdatedAt !== pendingReadyAt) {
    return { kind: "finish", capped: false, state: done() };
  }
  // The work ended but the turn that reports it has not run yet.
  clearedAtMs ??= nowMs;
  return nowMs - clearedAtMs < PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS
    ? { kind: "wait", started: false, publishPreview: false, state: done() }
    : { kind: "finish", capped: false, state: done() };
};

/** A turn of the attempt ended with background work left; the task still runs. */
export const isWaitingOnBackground = (
  state: BackgroundWait | undefined,
  attemptKey: string,
): boolean => state?.attemptKey === attemptKey && state.pendingReadyAt !== null;

/**
 * The replies of the turns that ended with background work left, then `last`
 * (the newest reply) unless it is one of them; the texts a result is made of.
 */
export const heldReplyTexts = (
  state: BackgroundWait | undefined,
  attemptKey: string,
  last: BackgroundReply | undefined,
): Array<string> => {
  const held = state?.attemptKey === attemptKey ? state.replies : [];
  const texts = held.map((reply) => reply.text);
  if (last !== undefined && !held.some((reply) => reply.messageId === last.messageId)) {
    texts.push(last.text);
  }
  return texts;
};
