import {
  taskListFor,
  taskStatusLabel,
  type TaskBucket,
  type TaskListFilter,
} from "@hbots/personal-client/conversation/taskPresentation";
import * as DateTime from "effect/DateTime";
import type { PersonalBot, PersonalRoutine, PersonalTask } from "@t3tools/contracts";

export type TaskBuckets = Record<TaskBucket, Array<PersonalTask>>;

const EMPTY_BUCKETS = (): TaskBuckets => ({ active: [], waiting: [], completed: [] });

/** Tasks grouped into running, waiting and finished, newest update first inside each. */
export function taskBuckets(tasks: ReadonlyMap<string, PersonalTask> | null): TaskBuckets {
  const grouped = EMPTY_BUCKETS();
  for (const task of tasks?.values() ?? []) grouped[taskListFor(task.status)].push(task);
  for (const list of Object.values(grouped)) {
    list.sort(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  }
  return grouped;
}

export function taskListCounts(
  buckets: TaskBuckets,
  routines: ReadonlyArray<PersonalRoutine>,
): Record<TaskListFilter, number> {
  return {
    work: buckets.active.length + buckets.waiting.length,
    scheduled: routines.filter((routine) => routine.enabled).length,
    completed: buckets.completed.length,
  };
}

export type TasksScreenState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready" };

/** The one state a task tab shows, from the two queries it reads. */
export function tasksScreenState(input: {
  readonly view: TaskListFilter;
  readonly tasks: ReadonlyMap<string, PersonalTask> | null;
  readonly taskError: string | null;
  readonly routinesLoaded: boolean;
  readonly routinesError: string | null;
}): TasksScreenState {
  if (input.view === "scheduled") {
    if (input.routinesError !== null) return { kind: "error", message: input.routinesError };
    return input.routinesLoaded ? { kind: "ready" } : { kind: "loading" };
  }
  if (input.taskError !== null) return { kind: "error", message: input.taskError };
  return input.tasks === null ? { kind: "loading" } : { kind: "ready" };
}

export const TASK_EMPTY_TEXT: Record<TaskListFilter, string> = {
  work: "No bot is working right now.",
  scheduled:
    "No routines yet. A routine gives a bot the same task on a schedule, or whenever an event fires.",
  completed: "Finished tasks will show up here.",
};

/** The row's second line: bot, status, and where the task came from. */
export function taskRowMeta(
  task: PersonalTask,
  botName: string | null,
  parentTitle: string | null,
): string {
  const parts = [
    botName ?? "Deleted bot",
    taskStatusLabel(task.status),
    parentTitle !== null ? `for "${parentTitle}"` : task.source === "routine" ? "Routine" : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

/** Pause and Resume reach only the picked routines that allow them. */
export function routineBulkTargets(
  routines: ReadonlyArray<PersonalRoutine>,
  chosen: ReadonlyArray<string>,
): { readonly toPause: ReadonlyArray<string>; readonly toResume: ReadonlyArray<string> } {
  const selected = new Set(chosen);
  return {
    toPause: routines
      .filter((routine) => routine.enabled && selected.has(routine.routineId))
      .map((routine) => routine.routineId),
    toResume: routines
      .filter((routine) => !routine.enabled && selected.has(routine.routineId))
      .map((routine) => routine.routineId),
  };
}

/** Bot by id, for the avatar and name on every task and routine row. */
export function botsById(
  bots: ReadonlyArray<PersonalBot> | undefined,
): ReadonlyMap<string, PersonalBot> {
  return new Map((bots ?? []).map((bot) => [bot.botId, bot]));
}

export function taskResultHeading(task: PersonalTask): string {
  return task.status === "running" && task.result?.waitingOnBackgroundSince !== undefined
    ? "Reply so far (still finishing background work)"
    : "Result";
}
