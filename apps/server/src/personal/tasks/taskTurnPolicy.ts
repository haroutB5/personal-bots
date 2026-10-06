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
): Array<string> =>
  [
    `Task id: ${task.taskId}`,
    `Title: ${task.title}`,
    `Objective:\n${task.objective}`,
    brief?.context ? `Context:\n${brief.context}` : null,
    brief?.constraints ? `Constraints:\n${brief.constraints}` : null,
    task.acceptanceCriteria ? `Acceptance criteria:\n${task.acceptanceCriteria}` : null,
    task.expectedOutput ? `Expected output:\n${task.expectedOutput}` : null,
  ].filter((section) => section !== null);

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

/** The text a steer is stored and delivered as. */
export const steerText = (fromName: string, message: string) =>
  ALREADY_PREFIXED.test(message.trim())
    ? message.trim()
    : `Update from ${fromName.trim() || "your delegator"}: ${message.trim()}`;
