import { PERSONAL_TASK_TERMINAL_STATUSES, type PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatSpan, type ProjectSummary } from "./projectCards.ts";
import { taskDisplayTitle } from "./taskPresentation.ts";
import {
  placeRunning,
  workLooseHeader,
  workTickLabel,
  type WorkBar,
  type WorkNow,
  type WorkNowRow,
} from "./workTimeline.ts";

export interface NowLine {
  readonly label: string;
  readonly line: string;
}

const ms = DateTime.toEpochMillis;

const ordinal = (position: number): string => {
  const tens = position % 100;
  if (tens >= 11 && tens <= 13) return `${position}th`;
  const suffix = ["th", "st", "nd", "rd"][position % 10] ?? "th";
  return `${position}${suffix}`;
};

const waitingOn = (names: ReadonlyArray<string>): string => {
  if (names.length === 0) return "Waiting on a helper";
  const shown = names.slice(0, 2).join(", ");
  return names.length <= 2 ? `Waiting on ${shown}` : `Waiting on ${shown} +${names.length - 2}`;
};

export function taskNowLine(input: {
  readonly task: PersonalTask;
  readonly note: string | undefined;
  readonly title: string;
  readonly childBotNames: ReadonlyArray<string>;
  readonly queuePosition: number | null;
  readonly nowMs: number;
}): NowLine {
  const { task, title } = input;
  const span = formatSpan(input.nowMs - ms(task.startedAt ?? task.createdAt));
  switch (task.status) {
    case "running": {
      const line =
        input.note !== undefined && input.note.trim().length > 0
          ? input.note
          : task.result?.waitingOnBackgroundSince !== undefined
            ? "Waiting on background work"
            : title;
      return { label: `Working · ${span}`, line };
    }
    case "waiting_for_agent":
      return { label: `Waiting · ${span}`, line: waitingOn(input.childBotNames) };
    case "waiting_for_user":
      return { label: "Needs you", line: "Waiting for your answer" };
    case "waiting_for_browser":
      return { label: "Needs you", line: "Needs you in the browser" };
    case "rate_limited":
      return {
        label: "Paused",
        line:
          task.availableAt === null
            ? "Usage limit"
            : `Usage limit · resumes ${workTickLabel(ms(task.availableAt))}`,
      };
    case "queued":
      return {
        label:
          input.queuePosition === null
            ? "Queued"
            : `Queued · ${ordinal(input.queuePosition)} in line`,
        line: title,
      };
    case "completed":
      return { label: "Finished", line: title };
    case "failed":
      return { label: "Failed", line: title };
    case "interrupted":
    case "cancelled":
      return { label: "Stopped", line: title };
  }
}

/**
 * Each waiting task's place in the server's queue, 1-based: queued tasks and
 * usage-limited ones whose wait is over, oldest first, as the server claims
 * them. Approximate, because the server skips a task whose chat is busy.
 */
function queuePositions(tasks: Iterable<PersonalTask>, nowMs: number): ReadonlyMap<string, number> {
  const waiting = [...tasks]
    .filter(
      (task) =>
        task.status === "queued" ||
        (task.status === "rate_limited" &&
          task.availableAt !== null &&
          ms(task.availableAt) <= nowMs),
    )
    .toSorted(
      (left, right) =>
        ms(left.createdAt) - ms(right.createdAt) ||
        (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0),
    );
  return new Map(waiting.map((task, index) => [task.taskId as string, index + 1] as const));
}

export interface GoalNowRow {
  readonly bar: WorkBar;
  readonly now: NowLine;
}

export interface RunningView {
  readonly rowsByProject: ReadonlyMap<string, ReadonlyArray<GoalNowRow>>;
  /** Live work outside every open goal, in today's "Running now" shape. */
  readonly loose: ReadonlyArray<WorkNowRow>;
  readonly looseHeader: string;
}

/**
 * The Work tab's live work, each bar under the goal its task serves, with the
 * line that says what it is doing now. Bars outside an open goal stay loose.
 */
export function buildRunningView(input: {
  readonly now: WorkNow;
  readonly tasks: ReadonlyMap<string, PersonalTask>;
  readonly summary: ProjectSummary;
  readonly notes: ReadonlyMap<string, string>;
  readonly chatTitles: ReadonlyMap<string, string>;
  readonly botName: (botId: string) => string;
  readonly nowMs: number;
}): RunningView {
  const { tasks, nowMs } = input;
  const openProjectIds = new Set(
    [...input.summary.cards, ...input.summary.more, ...input.summary.quiet].map(
      (card) => card.projectId,
    ),
  );
  const placed = placeRunning(input.now, tasks, openProjectIds);
  const queue = queuePositions(tasks.values(), nowMs);
  const childBotNames = (parentTaskId: string) => [
    ...new Set(
      [...tasks.values()]
        .filter(
          (task) =>
            task.parentTaskId === parentTaskId &&
            !PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status),
        )
        .map((task) => input.botName(task.botId)),
    ),
  ];
  const rowsByProject = new Map<string, ReadonlyArray<GoalNowRow>>();
  for (const [projectId, bars] of placed.byProject) {
    rowsByProject.set(
      projectId,
      bars.flatMap((bar) => {
        const task = bar.taskId === null ? undefined : tasks.get(bar.taskId);
        if (task === undefined) return [];
        const now = taskNowLine({
          task,
          note: task.threadId === null ? undefined : input.notes.get(task.threadId),
          title: taskDisplayTitle(task, input.chatTitles),
          childBotNames: childBotNames(task.taskId),
          queuePosition: queue.get(task.taskId) ?? null,
          nowMs,
        });
        return [{ bar, now }];
      }),
    );
  }
  const looseCount = placed.loose.reduce((count, row) => count + 1 + row.helpers.length, 0);
  return {
    rowsByProject,
    loose: placed.loose,
    looseHeader: workLooseHeader(input.summary.cards.length, looseCount),
  };
}
