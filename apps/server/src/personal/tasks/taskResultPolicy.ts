import type { PersonalTask } from "@t3tools/contracts";

import { PERSONAL_TASK_BACKGROUND_WAIT_MS } from "./taskBackgroundPolicy.ts";

/**
 * How a task's result is put together and what lists show of it: the reply of
 * each turn, the notes the task runner adds, and the short summary the live
 * feed carries instead of the full text. Pure.
 */

/** Added to the result of a task closed by the background-work cap. */
export const backgroundCapNote = (count: number) =>
  `(Closed by the task runner: ${count === 1 ? "a background command" : `${count} background commands`} the bot started ${count === 1 ? "was" : "were"} still running ${Math.round(PERSONAL_TASK_BACKGROUND_WAIT_MS / 60_000)} minutes after this reply. Anything the bot reports later is in its chat, not here.)`;

export const BACKGROUND_SESSION_ENDED_NOTE =
  "(Closed by the task runner: the bot's session ended while background work it started was still running.)";

/** `summary` followed by `note` on its own paragraph; either may be empty. */
export const withNote = (summary: string, note: string) =>
  note.length === 0 ? summary : summary.length === 0 ? note : `${summary}\n\n${note}`;

/** Put before each reply after the first one in a result. */
export const BACKGROUND_FOLLOW_UP_MARKER = "(Follow-up after background work finished:)";

/** A composed result longer than this loses its oldest follow-ups, never the first reply. */
export const PERSONAL_TASK_RESULT_MAX_CHARS = 100_000;
/** What a single follow-up keeps once it is all that is left to trim. */
const FOLLOW_UP_MIN_KEPT_CHARS = 1_000;

/**
 * One result from the replies of an attempt's turns, earliest first. The
 * first reply stays whole; every later one follows a marker. Past
 * {@link PERSONAL_TASK_RESULT_MAX_CHARS} the oldest follow-ups go first and
 * a line says how many; the newest follow-up is cut last.
 */
export const composeTaskReplies = (replies: ReadonlyArray<string>): string => {
  const [first, ...rest] = replies.filter((reply) => reply.trim().length > 0);
  if (first === undefined) return "";
  const kept = rest.map((reply) => `${BACKGROUND_FOLLOW_UP_MARKER}\n\n${reply}`);
  let dropped = 0;
  const compose = () =>
    [
      first,
      ...(dropped === 0
        ? []
        : [
            `(${dropped} earlier follow-up ${dropped === 1 ? "reply" : "replies"} left out to keep this result short.)`,
          ]),
      ...kept,
    ].join("\n\n");
  while (kept.length > 1 && compose().length > PERSONAL_TASK_RESULT_MAX_CHARS) {
    kept.shift();
    dropped += 1;
  }
  if (kept.length === 1 && compose().length > PERSONAL_TASK_RESULT_MAX_CHARS) {
    const budget = PERSONAL_TASK_RESULT_MAX_CHARS - (compose().length - kept[0]!.length);
    kept[0] = `${kept[0]!.slice(0, Math.max(budget, FOLLOW_UP_MIN_KEPT_CHARS)).trimEnd()}…`;
  }
  return compose();
};

/** Drops the "still waiting" mark from a result once the wait is over. */
export const withoutWaitingMarker = (result: PersonalTask["result"]): PersonalTask["result"] =>
  result === null || result.waitingOnBackgroundSince === undefined
    ? result
    : { summary: result.summary };

/**
 * Finished tasks replayed to a new subscriber; older ones come from
 * `history` and `related`. 200 with the task-summaries kill switch on,
 * which is what every client got before summaries.
 */
export const TASK_REPLAY_TERMINAL_LIMIT = 20;
export const TASK_REPLAY_TERMINAL_LIMIT_FULL = 200;

/** Longest result preview a summary carries; the delegation card shows 4 lines. */
export const TASK_SUMMARY_RESULT_PREVIEW_CHARS = 600;

export const TASK_HISTORY_DEFAULT_LIMIT = 20;
export const TASK_HISTORY_MAX_LIMIT = 100;
export const TASK_RELATED_MAX_IDS = 100;

/**
 * What lists and the live feed send: the task without its long text. The
 * objective and acceptance/expected-output bodies are blank and the result is
 * a preview; `personalTasks.get` has everything. Opening the app used to
 * download every task's full text (641 KB for 150 tasks).
 */
export const toTaskSummary = (task: PersonalTask): PersonalTask => {
  const summary = task.result?.summary;
  const preview =
    summary === undefined || summary.length <= TASK_SUMMARY_RESULT_PREVIEW_CHARS
      ? summary
      : `${summary.slice(0, TASK_SUMMARY_RESULT_PREVIEW_CHARS).trimEnd()}…`;
  return {
    ...task,
    objective: "",
    acceptanceCriteria: "",
    expectedOutput: "",
    result:
      task.result === null || preview === undefined ? null : { ...task.result, summary: preview },
    detailOmitted: true,
  };
};
