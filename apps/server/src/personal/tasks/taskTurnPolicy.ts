import type { PersonalDelegationBrief, PersonalTask, PersonalTaskStatus } from "@t3tools/contracts";

/**
 * The words of the turns a task sends to its bot: the opening brief, a retry,
 * a continuation with delegated results or updates, a reopened task. Pure; the
 * task service looks up what goes into them.
 */

/** Id prefix of the note that tells a reopened task it is continuing. */
export const PERSONAL_TASK_REOPEN_NOTE_PREFIX = "reopen:";

/** Tells a bot that a reopened task started a fresh session, and where its state is. */
export const FRESH_SESSION_NOTE =
  "This task was reopened after a long chat, so you start a fresh session and the earlier conversation is not in your context. The work record below is your state. When you need an exact detail from a message (a request, a number, a decision), call read_chat_history: it reads this chat's earlier messages, newest first, and can search them. It cannot show tool output (files you read, command results): run the command or read the file again if you need it.";

/** Ends a reopened task's continuation turn text, after the steer that reopened it. */
export const reopenNote = (status: PersonalTaskStatus) =>
  `This task had ${status === "completed" ? "finished" : `ended (${status})`} and has been reopened in this same chat. Continue where you stopped.`;

/** The opening line of a task's first turn, by where the task came from. */
export const sourceLabel = (task: Pick<PersonalTask, "source">, delegatorName: string | null) => {
  switch (task.source) {
    case "user":
      return "[Task from you]";
    case "routine":
      return "[Routine task]";
    case "delegation":
      return `[Delegated task from ${delegatorName ?? "another bot"}]`;
  }
};

/** The brief itself, section by section, skipping what is empty. */
export const taskSections = (
  task: Pick<
    PersonalTask,
    "taskId" | "title" | "objective" | "acceptanceCriteria" | "expectedOutput"
  >,
  brief: PersonalDelegationBrief | null,
  /** The delegating bot, when the task came from one: its own "From <name>" is dropped. */
  delegatorName: string | null = null,
): Array<string> => {
  const own = (text: string) =>
    delegatorName === null ? text : stripSelfAttribution(delegatorName, text);
  return [
    `Task id: ${task.taskId}`,
    `Title: ${task.title}`,
    `Objective:\n${own(task.objective)}`,
    brief?.context ? `Context:\n${own(brief.context)}` : null,
    brief?.constraints ? `Constraints:\n${own(brief.constraints)}` : null,
    task.acceptanceCriteria ? `Acceptance criteria:\n${task.acceptanceCriteria}` : null,
    task.expectedOutput ? `Expected output:\n${task.expectedOutput}` : null,
  ].filter((section) => section !== null) as Array<string>;
};

/** A parent's turn once delegated tasks have returned results. */
export const delegationContinuationText = (input: {
  /** Each finished delegation as `### title (status)` plus its result. */
  readonly results: ReadonlyArray<string>;
  /** Titles of delegated tasks that have not finished. */
  readonly stillRunningTitles: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<string>;
}): string => {
  const stillRunning = input.stillRunningTitles.length > 0;
  return [
    stillRunning
      ? "[Task continuation] These delegated tasks have finished. Their results:"
      : "[Task continuation] Your delegated tasks have finished. Their results:",
    ...input.results,
    ...(stillRunning
      ? [
          `Still running: ${input.stillRunningTitles.join(", ")}. Their results will follow in a later continuation.`,
        ]
      : []),
    ...input.notes,
    stillRunning
      ? "Continue the task below with these results. Do not give a final answer yet: the tasks still running will report back."
      : "Continue the task below with these results and give your final answer.",
    ...input.sections,
  ].join("\n\n");
};

/** A later turn that carries only updates sent since the last one (and a fresh-session seed). */
export const notesContinuationText = (input: {
  readonly notes: ReadonlyArray<string>;
  /** The work record that seeds a fresh session, or null when the session is resumed. */
  readonly freshRecord: string | null;
  readonly sections: ReadonlyArray<string>;
}): string =>
  [
    "[Task continuation]",
    ...input.notes,
    ...(input.freshRecord === null ? [] : [FRESH_SESSION_NOTE, input.freshRecord]),
    "Continue the task below.",
    ...input.sections,
  ].join("\n\n");

/** The first turn of a task, or its retry. */
export const openingTurnText = (input: {
  readonly header: string;
  readonly sections: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
}): string =>
  [
    input.header,
    ...input.sections,
    ...(input.notes.length > 0
      ? [`Updates since this task was handed over:\n\n${input.notes.join("\n\n")}`]
      : []),
  ].join("\n\n");

/** The header line of a first turn: the source label, plus the attempt number on a retry. */
export const openingTurnHeader = (label: string, attemptNumber: number) =>
  attemptNumber > 1 ? `${label} Retry, attempt ${attemptNumber}.` : label;

// A steer already written as "Update from <name>: ..." keeps its own prefix,
// so the bot does not read "Update from CTO: Update from CTO: ...".
const ALREADY_PREFIXED = /^update from [^:\n]{1,80}:/i;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Drops a sender's own attribution from the start of a message the app is
 * about to label itself: "From CTO.", "Update from CTO", "CTO:", "CTO here".
 * A steer "From CTO. Harout: ship it" then reads "Update from CTO: Harout:
 * ship it" instead of repeating "From CTO". Only the sender's own name is
 * dropped, case-insensitively, and only when text remains.
 */
export function stripSelfAttribution(fromName: string, message: string): string {
  const text = message.trim();
  const name = fromName.trim();
  if (name.length === 0) return text;
  const n = escapeRegExp(name);
  // Already labelled with the sender's name and a colon: keep the sender's own
  // wording (and case) exactly; ALREADY_PREFIXED below leaves it alone.
  if (new RegExp(`^update\\s+from\\s+${n}\\s*:`, "i").test(text)) return text;
  // The name has to end where it ends: "From Assistants notes" is not from
  // "Assistant", "From CTO's review" keeps its possessive and "From Developer
  // notes" is not from "Dev".
  const end = `(?![\\w'’])`;
  const prefix = new RegExp(
    `^(?:(?:update\\s+)?from\\s+${n}${end}(?:\\s+here\\b)?|${n}\\s+here\\b|${n}\\s*:)[\\s:,.!;\\-–—]*`,
    "i",
  );
  const stripped = text.replace(prefix, "").trim();
  return stripped.length > 0 ? stripped : text;
}

/** The text a steer is stored and delivered as. */
export const steerText = (fromName: string, message: string) => {
  const text = stripSelfAttribution(fromName, message);
  return ALREADY_PREFIXED.test(text)
    ? text
    : `Update from ${fromName.trim() || "your delegator"}: ${text}`;
};
