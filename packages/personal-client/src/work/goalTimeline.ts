import type {
  PersonalProject,
  PersonalProjectHistoryEntry,
  PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One line of a goal sheet's "What happened", newest first. */
export interface GoalTimelineEntry {
  /** Stable within one build, for the list renderer. */
  readonly key: string;
  readonly atMs: number;
  readonly text: string;
}

const ms = DateTime.toEpochMillis;

const stepText = (label: string, state: "done" | "doing" | "todo"): string =>
  state === "done"
    ? `Step done · ${label}`
    : state === "doing"
      ? `Step started · ${label}`
      : `Step reopened · ${label}`;

const taskEndText = (task: PersonalTask): string => {
  switch (task.status) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "interrupted":
      return "stopped";
    case "cancelled":
      return "cancelled";
    default:
      return "";
  }
};

/**
 * The goal sheet's history: what the lead changed, what its linked tasks did,
 * and when the goal opened or closed. Pure, so every string is tested.
 */
export function buildGoalTimeline(input: {
  readonly project: PersonalProject;
  readonly history: ReadonlyArray<PersonalProjectHistoryEntry>;
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly botName: (botId: string) => string;
}): ReadonlyArray<GoalTimelineEntry> {
  const { project, history, tasks, botName } = input;
  const entries: Array<GoalTimelineEntry & { readonly order: number }> = [];
  let order = 0;
  const add = (atMs: number, text: string) => {
    entries.push({ key: `event-${order}`, atMs, text, order: order++ });
  };

  add(ms(project.createdAt), `Goal opened by ${botName(project.leadBotId)}.`);
  for (const entry of history) {
    add(
      ms(entry.at),
      entry.kind === "step"
        ? stepText(entry.label, entry.state)
        : `Plan changed · ${entry.steps} steps`,
    );
  }
  for (const task of tasks) {
    const bot = botName(task.botId);
    if (task.startedAt !== null) {
      add(ms(task.startedAt), `${bot} started · ${task.title}`);
    }
    const end = taskEndText(task);
    if (end.length > 0) {
      add(ms(task.completedAt ?? task.updatedAt), `${bot} ${end} · ${task.title}`);
    }
  }
  if (project.state.kind !== "open") {
    add(ms(project.state.closedAt), project.state.kind === "done" ? "Goal done." : "Goal dropped.");
  }

  return entries
    .toSorted((left, right) => right.atMs - left.atMs || left.order - right.order)
    .map(({ key, atMs, text }) => ({ key, atMs, text }));
}

/** `h:mm` today, else `Mon h:mm`, on the phone's own clock. */
export function goalTimelineTime(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  const time = `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}`;
  return sameDay ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** How many history lines the sheet shows before "Show all". */
export const GOAL_TIMELINE_SHOWN = 6;
