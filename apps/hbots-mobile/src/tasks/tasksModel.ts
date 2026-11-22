import {
  taskListFor,
  taskStatusLabel,
  type TaskBucket,
  type TaskListFilter,
} from "@hbots/personal-client/conversation/taskPresentation";
import * as DateTime from "effect/DateTime";
import type {
  PersonalBot,
  PersonalProject,
  PersonalRoutine,
  PersonalTask,
} from "@t3tools/contracts";

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

/**
 * Unanswered question cards on the Work screen whose chat is not already
 * counted as an active or waiting task, so the Work badge never reads 0 while
 * a Needs-you card is visible.
 */
export function unansweredQuestionCount(
  questions: ReadonlyArray<{ readonly threadId: string }>,
  buckets: TaskBuckets,
): number {
  const liveThreads = new Set<string>();
  for (const task of buckets.active) {
    if (task.threadId !== null) liveThreads.add(task.threadId);
  }
  for (const task of buckets.waiting) {
    if (task.threadId !== null) liveThreads.add(task.threadId);
  }
  const seen = new Set<string>();
  for (const question of questions) {
    if (!liveThreads.has(question.threadId)) seen.add(question.threadId);
  }
  return seen.size;
}

/**
 * Top-level Work cards for live tasks: one per open project with live work,
 * one per standalone request row. A lead waiting on a shown helper adds
 * nothing. Null `projects` (not loaded) counts each project id once.
 */
export function workCardCount(
  buckets: TaskBuckets,
  projects: ReadonlyArray<PersonalProject> | null | undefined,
): number {
  const live = [...buckets.active, ...buckets.waiting];
  const byId = new Map(live.map((task) => [task.taskId as string, task]));
  const openProjectIds =
    projects === null || projects === undefined
      ? null
      : new Set(
          projects
            .filter((project) => project.state.kind === "open")
            .map((project) => project.projectId as string),
        );
  const projectOf = (task: PersonalTask): string | null => {
    const projectId = task.projectId ?? null;
    if (projectId === null) return null;
    return openProjectIds === null || openProjectIds.has(projectId) ? projectId : null;
  };
  const hasLiveChild = new Set<string>();
  for (const task of live) {
    if (task.parentTaskId !== null && byId.has(task.parentTaskId)) {
      hasLiveChild.add(task.parentTaskId);
    }
  }
  const waitingOnShownChild = (task: PersonalTask) =>
    task.status === "waiting_for_agent" && hasLiveChild.has(task.taskId);
  /** The topmost live standalone ancestor: one request row holds it and its helpers. */
  const rootOf = (task: PersonalTask): string => {
    let current = task;
    const seen = new Set<string>();
    while (current.parentTaskId !== null && !seen.has(current.taskId)) {
      seen.add(current.taskId);
      const parent = byId.get(current.parentTaskId);
      if (parent === undefined || projectOf(parent) !== null) break;
      current = parent;
    }
    return current.taskId;
  };
  const cards = new Set<string>();
  const looseRows = new Map<string, boolean>();
  for (const task of live) {
    const projectId = projectOf(task);
    if (projectId !== null) {
      cards.add(`project:${projectId}`);
      continue;
    }
    const root = rootOf(task);
    looseRows.set(root, (looseRows.get(root) ?? false) || !waitingOnShownChild(task));
  }
  for (const [root, counts] of looseRows) if (counts) cards.add(`task:${root}`);
  return cards.size;
}

/** Scheduled tab: enabled routines first, then paused ones under their own heading. */
export function routineSections(routines: ReadonlyArray<PersonalRoutine>): {
  readonly enabled: ReadonlyArray<PersonalRoutine>;
  readonly paused: ReadonlyArray<PersonalRoutine>;
} {
  return {
    enabled: routines.filter((routine) => routine.enabled),
    paused: routines.filter((routine) => !routine.enabled),
  };
}

export function taskListCounts(
  buckets: TaskBuckets,
  routines: ReadonlyArray<PersonalRoutine>,
  questionCount = 0,
  projects: ReadonlyArray<PersonalProject> | null = null,
): Record<TaskListFilter, number> {
  return {
    work: workCardCount(buckets, projects) + questionCount,
    scheduled: routineSections(routines).enabled.length,
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

/**
 * The project card's line under its name: the lead's own why, else the step
 * being worked on now, so it never reads as the chat the goal started in.
 */
export function projectCardSubtitle(card: {
  readonly why: string | null;
  readonly steps: ReadonlyArray<{ readonly label: string; readonly state: string }>;
}): string | null {
  const why = card.why?.trim() ?? "";
  if (why.length > 0) return why;
  return card.steps.find((step) => step.state === "doing")?.label ?? null;
}
