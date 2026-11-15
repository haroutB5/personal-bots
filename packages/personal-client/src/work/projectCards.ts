import {
  PERSONAL_TASK_TERMINAL_STATUSES,
  type PersonalProject,
  type PersonalProjectStep,
  type PersonalProjectStepState,
  type PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const PROJECT_CARDS_MAX = 4;
export const PROJECT_QUIET_MS = 72 * 60 * 60_000;
const FRESH_ESTIMATE_MS = 2 * 60 * 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** secondary: a fresh estimate. tertiary: an old one, or none. overdue: past dueAt (amber). */
export type ProjectEstimateTone = "secondary" | "tertiary" | "overdue";
/** working: a linked task runs. waiting: one waits on a bot or on you. idle: none is active. */
export type ProjectWhoTone = "working" | "waiting" | "idle";

export interface ProjectCard {
  readonly projectId: string;
  readonly leadBotId: string;
  readonly threadId: string | null;
  readonly name: string;
  readonly steps: ReadonlyArray<PersonalProjectStep>;
  /** One per step, in order: done filled, doing green, todo empty. */
  readonly segments: ReadonlyArray<PersonalProjectStepState>;
  readonly estimateLabel: string;
  readonly estimateTone: ProjectEstimateTone;
  /** The estimate's own times, for the sheet; null without one. */
  readonly estimate: { readonly dueMs: number; readonly estimatedMs: number } | null;
  readonly whoLine: string;
  readonly whoTone: ProjectWhoTone;
  /** The bot the avatar shows: the first working one, else the first waiting one. */
  readonly whoBotId: string | null;
  readonly stepLine: string;
  /** Linked tasks that are not finished, newest first. */
  readonly activeTaskIds: ReadonlyArray<string>;
  readonly lastActivityMs: number;
}

export interface ClosedProject {
  readonly projectId: string;
  readonly name: string;
  readonly outcome: "done" | "dropped";
  readonly closedMs: number;
}

export interface ProjectSummary {
  /** At most PROJECT_CARDS_MAX cards, busiest and most recent first. */
  readonly cards: ReadonlyArray<ProjectCard>;
  /** Open projects past the card limit, behind "+N more". */
  readonly more: ReadonlyArray<ProjectCard>;
  /** Open projects nobody works on and quiet for 72 h; still open, shown folded. */
  readonly quiet: ReadonlyArray<ProjectCard>;
  /** Closed projects the server still lists (last 30 days), newest first. */
  readonly closed: ReadonlyArray<ClosedProject>;
}

export const formatSpan = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(ms / HOUR);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(ms / (24 * HOUR))} d`;
};

const isActive = (task: PersonalTask) => !PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status);

const namesOf = (botIds: ReadonlyArray<string>, botName: (botId: string) => string) => {
  const names = [...new Set(botIds)].map(botName);
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
};

const estimateOf = (
  project: PersonalProject,
  nowMs: number,
): Pick<ProjectCard, "estimateLabel" | "estimateTone" | "estimate"> => {
  if (project.estimate === null) {
    return { estimateLabel: "No estimate yet", estimateTone: "tertiary", estimate: null };
  }
  const dueMs = DateTime.toEpochMillis(project.estimate.dueAt);
  const estimatedMs = DateTime.toEpochMillis(project.estimate.estimatedAt);
  const estimate = { dueMs, estimatedMs };
  if (nowMs >= dueMs) {
    return {
      estimateLabel: `Overdue by ${formatSpan(nowMs - dueMs)}`,
      estimateTone: "overdue",
      estimate,
    };
  }
  const left = `About ${formatSpan(dueMs - nowMs)} left`;
  const age = nowMs - estimatedMs;
  return age < FRESH_ESTIMATE_MS
    ? { estimateLabel: left, estimateTone: "secondary", estimate }
    : {
        estimateLabel: `${left} · est. ${formatSpan(age)} ago`,
        estimateTone: "tertiary",
        estimate,
      };
};

const stepLineOf = (steps: ReadonlyArray<PersonalProjectStep>): string => {
  const doing = steps.findIndex((step) => step.state === "doing");
  if (doing !== -1) return `Step ${doing + 1} of ${steps.length} · ${steps[doing]?.label ?? ""}`;
  const done = steps.filter((step) => step.state === "done").length;
  return done === steps.length
    ? `All ${steps.length} steps done`
    : `${done} of ${steps.length} steps done`;
};

const whoOf = (
  linked: ReadonlyArray<PersonalTask>,
  tasks: ReadonlyArray<PersonalTask>,
  botName: (botId: string) => string,
  quietMs: number,
): Pick<ProjectCard, "whoLine" | "whoTone" | "whoBotId"> => {
  const working = linked.filter((task) => task.status === "running");
  if (working.length > 0) {
    return {
      whoLine: `${namesOf(
        working.map((task) => task.botId),
        botName,
      )} working`,
      whoTone: "working",
      whoBotId: working[0]!.botId,
    };
  }
  const waiting = linked.find((task) => task.status !== "queued");
  if (waiting !== undefined) {
    const on =
      waiting.status === "waiting_for_agent"
        ? namesOf(
            tasks
              .filter((task) => task.parentTaskId === waiting.taskId && isActive(task))
              .map((task) => task.botId),
            botName,
          )
        : waiting.status === "rate_limited"
          ? "a usage limit"
          : "you";
    return {
      whoLine: `${botName(waiting.botId)} waiting on ${on.length > 0 ? on : "a helper"}`,
      whoTone: "waiting",
      whoBotId: waiting.botId,
    };
  }
  const queued = linked[0];
  if (queued !== undefined) {
    return {
      whoLine: `${botName(queued.botId)} queued`,
      whoTone: "waiting",
      whoBotId: queued.botId,
    };
  }
  return {
    whoLine: `Nobody on it · quiet ${formatSpan(quietMs)}`,
    whoTone: "idle",
    whoBotId: null,
  };
};

/**
 * The Work tab's projects: the lead's record (name, steps, estimate) joined to
 * the live task feed (who works now, last activity). Pure, so every label is
 * tested at a fixed `nowMs`.
 */
export function buildProjectCards(input: {
  readonly projects: ReadonlyArray<PersonalProject>;
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly nowMs: number;
  readonly botName: (botId: string) => string;
}): ProjectSummary {
  const { tasks, nowMs, botName } = input;
  const open: Array<ProjectCard> = [];
  const closed: Array<ClosedProject> = [];
  for (const project of input.projects) {
    if (project.state.kind !== "open") {
      closed.push({
        projectId: project.projectId,
        name: project.name,
        outcome: project.state.kind,
        closedMs: DateTime.toEpochMillis(project.state.closedAt),
      });
      continue;
    }
    const linked = tasks
      .filter((task) => task.projectId === project.projectId)
      .toSorted(
        (a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt),
      );
    const active = linked.filter(isActive);
    const lastActivityMs = Math.max(
      DateTime.toEpochMillis(project.lastActivityAt),
      ...linked.map((task) => DateTime.toEpochMillis(task.updatedAt)),
    );
    open.push({
      projectId: project.projectId,
      leadBotId: project.leadBotId,
      threadId: project.threadId,
      name: project.name,
      steps: project.steps,
      segments: project.steps.map((step) => step.state),
      ...estimateOf(project, nowMs),
      ...whoOf(active, tasks, botName, nowMs - lastActivityMs),
      stepLine: stepLineOf(project.steps),
      activeTaskIds: active.map((task) => task.taskId),
      lastActivityMs,
    });
  }
  const byActivity = (a: ProjectCard, b: ProjectCard) =>
    Number(b.activeTaskIds.length > 0) - Number(a.activeTaskIds.length > 0) ||
    b.lastActivityMs - a.lastActivityMs;
  const isQuiet = (card: ProjectCard) =>
    card.activeTaskIds.length === 0 && nowMs - card.lastActivityMs >= PROJECT_QUIET_MS;
  const awake = open.filter((card) => !isQuiet(card)).toSorted(byActivity);
  return {
    cards: awake.slice(0, PROJECT_CARDS_MAX),
    more: awake.slice(PROJECT_CARDS_MAX),
    quiet: open.filter(isQuiet).toSorted(byActivity),
    closed: closed.toSorted((a, b) => b.closedMs - a.closedMs),
  };
}
