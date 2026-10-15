// The delegation loop guard: a bot that re-sends the same brief on every
// continuation turn gets back the task that already covers it, instead of
// queueing a twin. It is not a work cap: only the exact same objective to the
// same bot inside one request dedupes, and a retry after a failure is new work.
import * as DateTime from "effect/DateTime";
import { PERSONAL_TASK_TERMINAL_STATUSES, type PersonalTask } from "@t3tools/contracts";

/** Kill switch, read on every delegation: `off` restores the plain behaviour. */
export const PERSONAL_TASKS_LOOP_GUARD_ENV = "PERSONAL_TASKS_LOOP_GUARD";
/** How long a completed task still absorbs a repeat of its bot and objective. */
export const PERSONAL_TASKS_LOOP_GUARD_MS = 30 * 60_000;

const OFF = new Set(["off", "0", "false", "no", "disabled"]);

/** The guard runs unless the kill switch says off. */
export const personalTasksLoopGuardEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const raw = env[PERSONAL_TASKS_LOOP_GUARD_ENV]?.trim().toLowerCase();
  return raw === undefined || raw.length === 0 || !OFF.has(raw);
};

/** Two briefs read the same when they match trimmed, case-insensitively, with inner whitespace collapsed. */
export const loopGuardObjective = (objective: string): string =>
  objective.trim().replace(/\s+/gu, " ").toLowerCase();

const stillActive = (status: PersonalTask["status"]): boolean =>
  !PERSONAL_TASK_TERMINAL_STATUSES.includes(status);

const completedRecently = (task: PersonalTask, nowMs: number): boolean =>
  task.status === "completed" &&
  task.completedAt !== null &&
  nowMs - DateTime.toEpochMillis(task.completedAt) < PERSONAL_TASKS_LOOP_GUARD_MS;

/**
 * The tasks a delegation repeats, newest first (as the repository returns
 * them): an earlier delegation in the same root, to the same bot, with the same
 * normalised objective, that is still active (queued, running, waiting or
 * rate-limited) or completed within the window. A failed, interrupted or
 * cancelled task never absorbs a retry.
 *
 * The chat is not on a task row, so the caller compares the chat itself: the
 * same words handed into a chat and handed over without one are two tasks
 * (1.66.12), and a chatless repeat is not one of the chat's twins.
 */
export const loopGuardMatches = (input: {
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly botId: string;
  readonly objective: string;
  readonly nowMs: number;
}): ReadonlyArray<PersonalTask> => {
  const wanted = loopGuardObjective(input.objective);
  return input.tasks.filter(
    (task) =>
      task.botId === input.botId &&
      loopGuardObjective(task.objective) === wanted &&
      (stillActive(task.status) || completedRecently(task, input.nowMs)),
  );
};
