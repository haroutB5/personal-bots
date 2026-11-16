import {
  hidesBotPreviews,
  PERSONAL_TASK_TERMINAL_STATUSES,
  type PersonalProject,
  type PersonalProjectStep,
  type PersonalProjectStepState,
  type PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isChatArchived } from "../bots/chatState.ts";

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
  readonly why: string | null;
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
  /**
   * Every project with live work, then idle ones up to PROJECT_CARDS_MAX,
   * busiest and most recent first. Live work never folds away.
   */
  readonly cards: ReadonlyArray<ProjectCard>;
  /** Idle open projects past the card limit, behind "+N more". */
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

/**
 * How long is left, in the card's own words. Under an hour stays exact. Above
 * it, round to the nearest half hour so "About 1 h 30 min left" is truthful and
 * "About 1 h left" is not shown for an hour and a half.
 */
export const formatTimeLeft = (ms: number): string => {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const rounded = Math.max(60, Math.round(minutes / 30) * 30);
    const hours = Math.floor(rounded / 60);
    const rest = rounded % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  return formatSpan(ms);
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
  const left = `About ${formatTimeLeft(dueMs - nowMs)} left`;
  const age = nowMs - estimatedMs;
  return age < FRESH_ESTIMATE_MS
    ? { estimateLabel: left, estimateTone: "secondary", estimate }
    : {
        estimateLabel: `${left} · est. ${formatSpan(age)} ago`,
        estimateTone: "tertiary",
        estimate,
      };
};

/** How far the plan got, in the pill's lowercase words: "step 2 of 5", "2 of 5 steps done". */
const stepCountOf = (steps: ReadonlyArray<PersonalProjectStep>): string => {
  const doing = steps.findIndex((step) => step.state === "doing");
  if (doing !== -1) return `step ${doing + 1} of ${steps.length}`;
  const done = steps.filter((step) => step.state === "done").length;
  return done === steps.length
    ? `all ${steps.length} steps done`
    : `${done} of ${steps.length} steps done`;
};

const stepLineOf = (steps: ReadonlyArray<PersonalProjectStep>): string => {
  const doing = steps.findIndex((step) => step.state === "doing");
  if (doing === -1) {
    const count = stepCountOf(steps);
    return `${count.charAt(0).toUpperCase()}${count.slice(1)}`;
  }
  return `Step ${doing + 1} of ${steps.length} · ${steps[doing]?.label ?? ""}`;
};

/** A goal as a chat shows it: enough to label a tag and open its sheet. */
export interface ChatGoalRef {
  readonly projectId: string;
  readonly name: string;
}

/** What one chat's goals say on its row. */
export interface ChatGoalTag {
  /** Open goals tagging it, in the server's order. */
  readonly open: ReadonlyArray<ChatGoalRef>;
  /** Goals closed done in the last week. */
  readonly doneCount: number;
}

/** The row's tag line, decided once so "No goal" cannot appear beside a tag. */
export type ChatRowTagLine =
  | {
      readonly kind: "tags";
      /** At most two, the ones the row names. */
      readonly goals: ReadonlyArray<ChatGoalRef>;
      /** Open goals past the two names. */
      readonly more: number;
      readonly done: number;
    }
  | { readonly kind: "noGoal" }
  | { readonly kind: "none" };

/** One goal's pill at the top of a chat. */
export interface ChatGoalPill {
  readonly projectId: string;
  readonly name: string;
  readonly text: string;
}

const GOAL_DONE_WINDOW_MS = 7 * 24 * HOUR;
const CHAT_ROW_GOAL_NAMES = 2;

/** The chats a goal tags. An old server sends no `chats`, so its own chat stands in. */
const chatsOfProject = (project: PersonalProject): ReadonlyArray<string> => {
  const chats = project.chats ?? (project.threadId === null ? [] : [project.threadId]);
  return [...new Set(chats)];
};

/**
 * Which goals each chat carries: open goals tag their chats, goals closed done
 * in the last week count on them, dropped goals say nothing.
 */
export function chatGoalTags(
  projects: ReadonlyArray<PersonalProject>,
  nowMs: number,
): ReadonlyMap<string, ChatGoalTag> {
  const tags = new Map<string, { open: Array<ChatGoalRef>; doneCount: number }>();
  const tagOf = (threadId: string) => {
    const existing = tags.get(threadId);
    if (existing !== undefined) return existing;
    const created = { open: [] as Array<ChatGoalRef>, doneCount: 0 };
    tags.set(threadId, created);
    return created;
  };
  for (const project of projects) {
    if (project.state.kind === "dropped") continue;
    const done =
      project.state.kind === "done" &&
      nowMs - DateTime.toEpochMillis(project.state.closedAt) <= GOAL_DONE_WINDOW_MS;
    if (project.state.kind !== "open" && !done) continue;
    for (const threadId of chatsOfProject(project)) {
      const tag = tagOf(threadId);
      if (project.state.kind === "open") {
        tag.open.push({ projectId: project.projectId, name: project.name });
      } else {
        tag.doneCount += 1;
      }
    }
  }
  return tags;
}

/**
 * Whether the goal tags cover every chat: true only when the list loaded and
 * the server sends each goal's `chats`. An old server sends none, so a chat
 * with no tag cannot be called goal-free.
 */
export function chatGoalTagsComplete(projects: ReadonlyArray<PersonalProject> | null): boolean {
  return projects !== null && projects.some((project) => project.chats !== undefined);
}

/**
 * The chat row's one tag line. "No goal" shows only on a chat working now,
 * with no tag at all, and only when the goals list can tell (see
 * `chatGoalTagsComplete`).
 */
export function chatRowTagLine(
  tag: ChatGoalTag | undefined,
  workingNow: boolean,
  tagsComplete: boolean,
): ChatRowTagLine {
  if (tag === undefined || (tag.open.length === 0 && tag.doneCount === 0)) {
    return workingNow && tagsComplete ? { kind: "noGoal" } : { kind: "none" };
  }
  return {
    kind: "tags",
    goals: tag.open.slice(0, CHAT_ROW_GOAL_NAMES),
    more: Math.max(0, tag.open.length - CHAT_ROW_GOAL_NAMES),
    done: tag.doneCount,
  };
}

const pillEstimateOf = (project: PersonalProject, nowMs: number): string => {
  if (project.estimate === null) return "";
  const dueMs = DateTime.toEpochMillis(project.estimate.dueAt);
  return nowMs >= dueMs
    ? ` · overdue by ${formatSpan(nowMs - dueMs)}`
    : ` · ~${formatTimeLeft(dueMs - nowMs)}`;
};

/**
 * One pill per open goal on the chat, the way the chat's top strip shows it:
 * `◎ name · step 2 of 5 · ~1 h ›`.
 */
export function chatGoalPills(input: {
  readonly projects: ReadonlyArray<PersonalProject>;
  readonly threadId: string;
  readonly nowMs: number;
}): ReadonlyArray<ChatGoalPill> {
  return input.projects.flatMap((project) =>
    project.state.kind !== "open" || !chatsOfProject(project).includes(input.threadId)
      ? []
      : [
          {
            projectId: project.projectId,
            name: project.name,
            text: `◎ ${project.name} · ${stepCountOf(project.steps)}${pillEstimateOf(
              project,
              input.nowMs,
            )} ›`,
          },
        ],
  );
}

/** A chat a goal line can name: the open chat's own title. */
export interface GoalChatLookup {
  readonly title: string;
}

/**
 * The open chats, keyed by thread id, with the shell's title. Archived and
 * deleted chats are left out, so a goal naming one shows its bot alone.
 */
export function goalChatMap(input: {
  readonly shells: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly archivedAt?: string | null | undefined;
  }>;
  readonly links: ReadonlyArray<{
    readonly threadId: string;
    readonly archivedAt: DateTime.Utc | null;
  }>;
}): ReadonlyMap<string, GoalChatLookup> {
  const linkById = new Map(input.links.map((link) => [link.threadId, link]));
  const chats = new Map<string, GoalChatLookup>();
  for (const shell of input.shells) {
    if (isChatArchived(linkById.get(shell.id), shell)) continue;
    chats.set(shell.id, { title: shell.title });
  }
  return chats;
}

/** The line under a goal's title: the lead bot, and the chat it runs the goal in. */
export interface GoalChatLine {
  readonly botId: string;
  /** Shown whole: the row never ellipsizes it. */
  readonly botName: string;
  /** Ellipsized by the row when long; null when the chat cannot be named. */
  readonly chatTitle: string | null;
  /** What a tap opens; null when the chat is gone or was never set. */
  readonly threadId: string | null;
}

/**
 * Which chat runs a goal, as its card and sheet name it. The bot always shows.
 * The chat names itself only while it is still open and the bot does not hide
 * previews; a tap opens it only while it is open.
 */
export function goalChatLine(input: {
  readonly leadBotId: string;
  readonly threadId: string | null;
  readonly bot: { readonly name: string; readonly hidePreviews?: boolean } | null | undefined;
  readonly chats: ReadonlyMap<string, GoalChatLookup>;
}): GoalChatLine {
  const botName = input.bot?.name ?? "Removed bot";
  const chat = input.threadId === null ? undefined : input.chats.get(input.threadId);
  if (chat === undefined) {
    return { botId: input.leadBotId, botName, chatTitle: null, threadId: null };
  }
  const hidden = input.bot !== null && input.bot !== undefined && hidesBotPreviews(input.bot);
  return {
    botId: input.leadBotId,
    botName,
    chatTitle: hidden ? null : chat.title,
    threadId: input.threadId,
  };
}

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
      why: project.why ?? null,
      steps: project.steps,
      segments: project.steps.map((step) => step.state),
      ...estimateOf(project, nowMs),
      ...whoOf(active, tasks, botName, nowMs - lastActivityMs),
      stepLine: stepLineOf(project.steps),
      activeTaskIds: active.map((task) => task.taskId),
      lastActivityMs,
    });
  }
  // Live work first. An overdue goal outranks every idle one so it can never
  // be the card that folds behind "+N more".
  const rank = (card: ProjectCard) =>
    card.activeTaskIds.length > 0 ? 0 : card.estimateTone === "overdue" ? 1 : 2;
  const byActivity = (a: ProjectCard, b: ProjectCard) =>
    rank(a) - rank(b) || b.lastActivityMs - a.lastActivityMs;
  const isQuiet = (card: ProjectCard) =>
    card.activeTaskIds.length === 0 && nowMs - card.lastActivityMs >= PROJECT_QUIET_MS;
  const awake = open.filter((card) => !isQuiet(card)).toSorted(byActivity);
  const live = awake.filter((card) => card.activeTaskIds.length > 0);
  const idle = awake.filter((card) => card.activeTaskIds.length === 0);
  const room = Math.max(0, PROJECT_CARDS_MAX - live.length);
  return {
    cards: [...live, ...idle.slice(0, room)],
    more: idle.slice(room),
    quiet: open.filter(isQuiet).toSorted(byActivity),
    closed: closed.toSorted((a, b) => b.closedMs - a.closedMs),
  };
}
