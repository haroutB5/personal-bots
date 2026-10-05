import {
  PERSONAL_NOTIFY_MESSAGE_MAX_CHARS,
  type PersonalRoutineNotifyMode,
} from "@t3tools/contracts";

/**
 * What a finished task earns, given the routine's notify mode and what the bot
 * said with notify_user (see migration 098). Pure: the push service reads the
 * run's state from the database and applies this.
 *
 * The decision only ever gates a COMPLETED run. A failed run and a run that
 * needs the user (a secret request, browser help, waiting_for_user) always
 * notify, in every mode: those are not "results" the bot can judge unimportant.
 * Mute, notification preferences and quiet hours apply on top, after this.
 */
export interface TaskNotifyState {
  /** Null for a run with no mode (every task that is not a routine's): it behaves as `always`. */
  readonly mode: PersonalRoutineNotifyMode | null;
  /** The bot's last notify_user call: true = notify, false = silent, null = never called. */
  readonly decision: boolean | null;
  readonly message: string | null;
}

export type TaskNotifyVerdict =
  | {
      readonly _tag: "Send";
      /** The bot's own one-line message, to use as the push body instead of the task title. */
      readonly body?: string;
    }
  | { readonly _tag: "Skip"; readonly path: "bot-skipped" | "routine-never" };

export function taskNotifyVerdict(taskStatus: string, state: TaskNotifyState): TaskNotifyVerdict {
  if (taskStatus !== "completed") return { _tag: "Send" };
  const body = state.decision === true && state.message !== null ? state.message : undefined;
  const send: TaskNotifyVerdict = body === undefined ? { _tag: "Send" } : { _tag: "Send", body };
  switch (state.mode) {
    case "never":
      return { _tag: "Skip", path: "routine-never" };
    case "bot_decides":
      return state.decision === true ? send : { _tag: "Skip", path: "bot-skipped" };
    case "always":
    case null:
      return send;
  }
}

/**
 * The bot's message as a one-line lock-screen body: whitespace collapsed,
 * anything that looks like a key or token hidden, cut at
 * {@link PERSONAL_NOTIFY_MESSAGE_MAX_CHARS} characters with an ellipsis.
 * Null when nothing is left (the push then uses the task title as before).
 */
export function cleanNotifyMessage(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{6,}/g, "[hidden]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [hidden]")
    .trim();
  if (cleaned.length === 0) return null;
  const characters = Array.from(cleaned);
  return characters.length > PERSONAL_NOTIFY_MESSAGE_MAX_CHARS
    ? `${characters
        .slice(0, PERSONAL_NOTIFY_MESSAGE_MAX_CHARS - 1)
        .join("")
        .trimEnd()}…`
    : cleaned;
}
