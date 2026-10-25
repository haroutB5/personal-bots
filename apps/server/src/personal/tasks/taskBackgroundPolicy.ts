/**
 * Whether a Claude task is really finished when its turn ends. Claude Code
 * lets a turn end while commands it started in the background run on, then
 * runs a new turn by itself when they finish, and the bot's report is in that
 * turn. This is the state machine for that wait, as pure functions: the task
 * service keeps one {@link BackgroundWait} per provider thread with an active
 * attempt and feeds it what the session and the liveness registry say.
 */

/**
 * How long a wait runs before the delegating lead is told about it, once per
 * attempt. This is a notice, never a close: Harout's rule (25 Oct) is that a
 * task stays running while its bot has work in flight or says it is waiting,
 * and ends only when the bot finishes, fails, or the orchestrator stops or
 * steers it. A background command can legitimately run this long (a gate
 * queued behind the machine-wide heavy-job lock), and a delegated task may
 * wait on another chat's branch. The lead can see the notice and stop a truly
 * stuck task itself.
 */
export const PERSONAL_TASK_WAIT_NOTICE_MS = 20 * 60_000;

/**
 * The only hard stop for a wait that never ends: a runaway command (a dev
 * server left running) or a bot that keeps saying it is waiting forever. Far
 * longer than any real build or gate, so it can only catch a leak; the task
 * closes with a note on the replies it has, and the lead is told first.
 */
export const PERSONAL_TASK_WAIT_HARD_CAP_MS = 8 * 60 * 60_000;

/**
 * Once the background work has ended, how long to wait for the turn Claude
 * Code starts to report it before the latest reply stands as the result. A
 * reply that says the bot is still waiting is not closed this way; only a
 * reply that reads as a result is.
 */
export const PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS = 60_000;

/** Reply phrases that mean nothing is finished yet; not a report. */
const NEGATED_WAIT =
  /\b(?:nothing|no one|none)\b[^.!?]{0,30}\b(?:waiting|running|pending)\b|\b(?:not|no longer|isn't|aren't|won't|will not)\b[^.!?]{0,20}\b(?:waiting|running|blocked)\b/gi;

/**
 * Whether the bot's reply says it is still waiting for work to finish, rather
 * than reporting a result. Deliberately narrow: only the newest line (or the
 * tail of a one-line reply) counts, so a phrase from earlier in a long report
 * cannot hold it, and a negated phrase ("nothing is still running") never
 * does. Both of the shapes seen live must match: the future tense that names
 * what happens next ("I'll merge it once it lands", "I'll report when it
 * finishes") and the present state ("still running", "queued behind",
 * "waiting on", "watching for").
 */
export const saysItIsWaiting = (text: string | undefined): boolean => {
  if (text === undefined) return false;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1) ?? "";
  const line = (lastLine.length > 0 ? lastLine : text).slice(-600);
  const tail = line.replace(NEGATED_WAIT, " ").replace(/\s+/g, " ").trim();
  if (tail.length === 0) return false;
  // "I'll report/merge/continue/pick this up ... once it finishes/appears."
  if (
    /\b(?:i'?ll|i will|i'?m going to|i am going to)\b[^.!?]{0,200}\b(?:wait|watch|continue|carry on|pick\b[^.!?]{0,40}\bup|resume|report|read|rerun|re-run|run|merge|check|come back|try again|retry)\b[^.!?]{0,100}\b(?:when|once|after|until|as soon as|if)\b/i.test(
      tail,
    )
  ) {
    return true;
  }
  // The bot's work is still live right now: "still running the Brave proof",
  // "still going on the gate". A server left up for QA is not work in flight,
  // so the run has to name a piece of work after it.
  if (
    /\b(?:still|currently)\s+(?:running|going|in progress|queued|working|building|being (?:run|built|tested|proven))\b[^.!?]{0,80}\b(?:build|gate|gates|test|tests|vitest|typecheck|lint|proof|run|job|command|process|export|check|checks|browser|script|pipeline|deploy|backup|copy|work)\b/i.test(
      tail,
    )
  ) {
    return true;
  }
  if (/\b(?:still|currently)\s+(?:queued|in progress|in the background)\b/i.test(tail)) return true;
  if (/\bqueued behind\b|\bheld (?:up )?(?:by|behind|on)\b/i.test(tail)) return true;
  // An explicit wait or watch, with nothing finished to report.
  if (
    /\b(?:waiting|wait|waits|watch|watches|watching|blocked|parked)\s+(?:on|for|by|behind)\b|\bre-?armed the watch\b|\bwatch(?:er)? is still running\b/i.test(
      tail,
    )
  ) {
    return true;
  }
  // "in the background, so I have no result yet."
  return (
    /\bin the background\b/i.test(tail) && /\b(?:no result|not (?:done|finished)|yet)\b/i.test(tail)
  );
};

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
  /** Since when the bot's own replies say it is still waiting, epoch ms; null = never. */
  readonly statedWaitSinceMs: number | null;
  /** The reply whose words said it; settling the same turn again restarts nothing. */
  readonly statedWaitMessageId: string | null;
  /** When the delegating lead was told about this wait, epoch ms; null = not yet. */
  readonly noticedAtMs: number | null;
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
  statedWaitSinceMs: null,
  statedWaitMessageId: null,
  noticedAtMs: null,
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
  /** The newest reply says the bot is still waiting (Claude only; see {@link saysItIsWaiting}). */
  readonly statedWait: boolean;
}

export type BackgroundStep = {
  readonly state: BackgroundWait;
} & (
  | {
      /** Keep the attempt open. */
      readonly kind: "wait";
      /** The wait just began, or a new reply said it is still waiting: say so once. */
      readonly started: boolean;
      /** This turn's reply was just held: show the replies so far on the task. */
      readonly publishPreview: boolean;
      /** Held by the bot's own words rather than by work the app can see running. */
      readonly stated: boolean;
      /** The wait has run long enough to tell the delegating lead, once. */
      readonly noticeDue: boolean;
    }
  | {
      /** End the attempt now: `capped` = the runaway hard cap ran out. */
      readonly kind: "finish";
      readonly capped: boolean;
      /** Which wait ran out: tracked work, or the bot's own words. */
      readonly capSource: "background" | "stated" | null;
    }
);

/**
 * Advances the wait by one ended turn.
 *
 * Nothing here closes a task on a timer: Harout's rule (25 Oct) is that it
 * runs until the bot finishes, fails, or the orchestrator stops or steers it.
 * With background work still live the turn's reply is held and the attempt
 * waits; a reply that says the bot is still waiting is held the same way,
 * because Claude Code starts no follow-up turn for work it does not own.
 * After {@link PERSONAL_TASK_WAIT_NOTICE_MS} the step asks for one notice to
 * the delegating lead. Only a wait that reaches
 * {@link PERSONAL_TASK_WAIT_HARD_CAP_MS} (a runaway command) closes the task,
 * with a note. With no work live, a task that never waited ends as it always
 * has; a task that waited ends on the next turn that follows the one that
 * left the work, or after {@link PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS} of
 * waiting for that turn.
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
  let statedWaitSinceMs = current.statedWaitSinceMs;
  let statedWaitMessageId = current.statedWaitMessageId;
  let noticedAtMs = current.noticedAtMs;
  const { nowMs } = input;
  const done = (): BackgroundWait => ({
    ...current,
    pendingReadyAt,
    idleSinceMs,
    clearedAtMs,
    waitingSince,
    replies,
    statedWaitSinceMs,
    statedWaitMessageId,
    noticedAtMs,
  });

  // Hold this turn's reply before anything else, so no later turn, cap or
  // session end can replace it, and start the stated wait on the first reply
  // that said the bot is waiting.
  const reply =
    input.last !== undefined &&
    input.last.text.trim().length > 0 &&
    !replies.some((held) => held.messageId === input.last!.messageId)
      ? input.last
      : undefined;
  const statedNow = input.statedWait && input.last !== undefined;
  // A wait once stated stays in force while the newest reply is still the one
  // that said it (a sweep with nothing new ends nothing); a newer reply that
  // says something else clears it.
  const stated =
    statedNow ||
    (current.statedWaitMessageId !== null &&
      (input.last === undefined || input.last.messageId === current.statedWaitMessageId));
  const newStatement = statedNow && input.last!.messageId !== current.statedWaitMessageId;
  if (newStatement) {
    statedWaitMessageId = input.last!.messageId;
    statedWaitSinceMs ??= nowMs;
    waitingSince ??= input.sessionUpdatedAt;
  }
  const hold = (started: boolean, sinceMs: number): BackgroundStep => {
    if (reply !== undefined) {
      replies = [...replies, { messageId: reply.messageId, text: reply.text }];
    }
    const noticeDue = noticedAtMs === null && nowMs - sinceMs >= PERSONAL_TASK_WAIT_NOTICE_MS;
    if (noticeDue) noticedAtMs = nowMs;
    return {
      kind: "wait",
      started: started || newStatement,
      publishPreview: reply !== undefined,
      stated,
      noticeDue,
      state: done(),
    };
  };
  const cap = (source: "background" | "stated"): BackgroundStep => ({
    kind: "finish",
    capped: true,
    capSource: source,
    state: done(),
  });
  const runaway = (sinceMs: number) => nowMs - sinceMs >= PERSONAL_TASK_WAIT_HARD_CAP_MS;

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
    // Tracked work is live: stay running, however long the gate or build takes.
    return runaway(idleSinceMs) ? cap("background") : hold(started, idleSinceMs);
  }
  // Never waited on tracked work and said nothing about waiting: the turn ends
  // the task exactly as it always has.
  if (pendingReadyAt === null) {
    if (!stated) return { kind: "finish", capped: false, capSource: null, state: done() };
    return runaway(statedWaitSinceMs ?? nowMs)
      ? cap("stated")
      : hold(false, statedWaitSinceMs ?? nowMs);
  }
  // A turn ended after the one that left the work: its reply is the result,
  // unless the reply itself says the bot is still waiting.
  if (input.sessionUpdatedAt !== pendingReadyAt) {
    if (!stated) return { kind: "finish", capped: false, capSource: null, state: done() };
    return runaway(statedWaitSinceMs ?? nowMs)
      ? cap("stated")
      : hold(false, statedWaitSinceMs ?? nowMs);
  }
  // The work ended but the turn that reports it has not run yet.
  clearedAtMs ??= nowMs;
  if (stated) {
    return runaway(statedWaitSinceMs ?? nowMs)
      ? cap("stated")
      : hold(false, statedWaitSinceMs ?? nowMs);
  }
  return nowMs - clearedAtMs < PERSONAL_TASK_BACKGROUND_FOLLOW_UP_MS
    ? {
        kind: "wait",
        started: false,
        publishPreview: false,
        stated: false,
        noticeDue: false,
        state: done(),
      }
    : { kind: "finish", capped: false, capSource: null, state: done() };
};

/** A turn of the attempt ended with background work left; the task still runs. */
export const isWaitingOnBackground = (
  state: BackgroundWait | undefined,
  attemptKey: string,
): boolean =>
  state?.attemptKey === attemptKey &&
  (state.pendingReadyAt !== null || state.statedWaitMessageId !== null);

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
