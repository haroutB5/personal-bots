import { PERSONAL_TASK_TERMINAL_STATUSES, type PersonalTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * How a bar is drawn. working: solid green. waitingOthers: striped green.
 * needsYou: amber. failed: red. done and stopped: dim. queued: dashed box
 * right of the now line.
 */
export type WorkTone =
  | "working"
  | "waitingOthers"
  | "needsYou"
  | "failed"
  | "done"
  | "stopped"
  | "queued";

/** A chat turn the owner started that is not (yet) a task. */
export interface WorkChatTurn {
  readonly threadId: string;
  readonly turnId: string | null;
  readonly botId: string;
  readonly title: string;
  readonly startedMs: number;
  /** Null while the turn is running. */
  readonly endedMs: number | null;
  /** The chat waits for an approval or an answer from the owner. */
  readonly needsYou: boolean;
}

export interface WorkBar {
  /** Stable key: `task:<id>` or `chat:<threadId>`. */
  readonly id: string;
  readonly taskId: string | null;
  readonly threadId: string | null;
  readonly botId: string;
  readonly title: string;
  readonly tone: WorkTone;
  readonly startMs: number;
  /** Null while the work has not ended. */
  readonly endMs: number | null;
  /**
   * When the bar stopped being plain work and began waiting, for the tones
   * that wait. It is the last status change the server recorded, so it is the
   * latest the wait can have begun, never a guess at an earlier time.
   */
  readonly waitSinceMs: number | null;
}

export interface WorkLane {
  readonly botId: string;
  /** 0 for the bot the request went to, 1 for a helper it asked, and so on. */
  readonly depth: number;
  readonly bars: ReadonlyArray<WorkBar>;
}

export type WorkInitiator =
  /** The owner, in the chat with this title. */
  | { readonly kind: "you"; readonly title: string }
  /** A routine with this name. */
  | { readonly kind: "routine"; readonly title: string }
  /** The first task of the request is not known to this client yet. */
  | { readonly kind: "unknown" };

export interface WorkGroup {
  readonly key: string;
  readonly initiator: WorkInitiator;
  readonly lanes: ReadonlyArray<WorkLane>;
  readonly needsYou: boolean;
  readonly active: boolean;
  readonly lastMs: number;
}

export interface WorkTimeline {
  readonly startMs: number;
  readonly nowMs: number;
  readonly groups: ReadonlyArray<WorkGroup>;
  /** Every bar that waits for the owner, oldest wait first. */
  readonly needs: ReadonlyArray<WorkBar>;
  /** Bots with no bar in the window, in the order they were given. */
  readonly idleBotIds: ReadonlyArray<string>;
  /** Root tasks named by a task here but missing from `tasks`. */
  readonly missingRootIds: ReadonlyArray<string>;
}

export interface WorkTimelineInput {
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly chats: ReadonlyArray<WorkChatTurn>;
  readonly botIds: ReadonlyArray<string>;
  readonly nowMs: number;
  readonly rangeMs: number;
}

const ms = DateTime.toEpochMillis;

const isTerminal = (task: PersonalTask) => PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status);

function taskTone(task: PersonalTask): WorkTone {
  switch (task.status) {
    case "queued":
      return "queued";
    case "running":
      return task.result?.waitingOnBackgroundSince === undefined ? "working" : "waitingOthers";
    case "waiting_for_agent":
    case "rate_limited":
      return "waitingOthers";
    case "waiting_for_user":
    case "waiting_for_browser":
      return "needsYou";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "stopped";
  }
}

function taskWaitSince(task: PersonalTask, tone: WorkTone, startMs: number): number | null {
  if (tone !== "waitingOthers" && tone !== "needsYou") return null;
  const background = task.result?.waitingOnBackgroundSince;
  const parsed = background === undefined ? Number.NaN : Date.parse(background);
  const since = Number.isNaN(parsed) ? ms(task.updatedAt) : parsed;
  return Math.max(startMs, since);
}

function taskBar(task: PersonalTask): WorkBar {
  const tone = taskTone(task);
  const startMs = ms(task.startedAt ?? task.createdAt);
  const endMs = isTerminal(task) ? Math.max(startMs, ms(task.completedAt ?? task.updatedAt)) : null;
  return {
    id: `task:${task.taskId as string}`,
    taskId: task.taskId as string,
    threadId: task.threadId === null ? null : (task.threadId as string),
    botId: task.botId as string,
    title: task.title,
    tone,
    startMs,
    endMs,
    waitSinceMs: taskWaitSince(task, tone, startMs),
  };
}

function chatBar(chat: WorkChatTurn): WorkBar {
  const running = chat.endedMs === null;
  const tone: WorkTone = chat.needsYou ? "needsYou" : running ? "working" : "done";
  return {
    id: `chat:${chat.threadId}`,
    taskId: null,
    threadId: chat.threadId,
    botId: chat.botId,
    title: chat.title,
    tone,
    startMs: chat.startedMs,
    endMs: chat.needsYou ? null : chat.endedMs,
    // A waiting chat has no recorded time for when the wait began.
    waitSinceMs: chat.needsYou ? (chat.endedMs ?? null) : null,
  };
}

const inWindow = (bar: WorkBar, startMs: number) =>
  bar.endMs === null ? true : bar.endMs >= startMs;

const isActiveTone = (tone: WorkTone) =>
  tone === "working" || tone === "waitingOthers" || tone === "needsYou" || tone === "queued";

/** A chat turn a task already stands for: the task's bar is the one to draw. */
function chatCoveredByTask(chat: WorkChatTurn, tasks: ReadonlyArray<PersonalTask>): boolean {
  const turnKey = chat.turnId === null ? null : `thread-turn:${chat.threadId}:${chat.turnId}`;
  return tasks.some((task) => {
    if (turnKey !== null && task.idempotencyKey === turnKey) return true;
    return task.threadId === chat.threadId && !isTerminal(task) && chat.endedMs === null;
  });
}

function initiatorOf(root: PersonalTask | undefined): WorkInitiator {
  if (root === undefined) return { kind: "unknown" };
  if (root.source === "routine") return { kind: "routine", title: root.title };
  if (root.source === "user") return { kind: "you", title: root.title };
  return { kind: "unknown" };
}

function buildLanes(
  bars: ReadonlyArray<{ readonly bar: WorkBar; readonly depth: number }>,
): WorkLane[] {
  const byBot = new Map<string, { depth: number; bars: WorkBar[] }>();
  for (const { bar, depth } of bars) {
    const lane = byBot.get(bar.botId);
    if (lane === undefined) byBot.set(bar.botId, { depth, bars: [bar] });
    else {
      lane.depth = Math.min(lane.depth, depth);
      lane.bars.push(bar);
    }
  }
  return [...byBot.entries()]
    .map(([botId, lane]) => ({
      botId,
      depth: lane.depth,
      bars: lane.bars.toSorted((left, right) => left.startMs - right.startMs),
    }))
    .toSorted(
      (left, right) =>
        left.depth - right.depth || (left.bars[0]?.startMs ?? 0) - (right.bars[0]?.startMs ?? 0),
    );
}

const lastMsOf = (bar: WorkBar, nowMs: number) => bar.endMs ?? nowMs;

/**
 * Everything the Work tab draws: one group per request, a lane per bot inside
 * it, a bar per piece of work. It only reports times the server recorded.
 */
export function buildWorkTimeline(input: WorkTimelineInput): WorkTimeline {
  const { tasks, chats, botIds, nowMs, rangeMs } = input;
  const startMs = nowMs - rangeMs;
  const tasksById = new Map(tasks.map((task) => [task.taskId as string, task] as const));

  const grouped = new Map<string, { bar: WorkBar; depth: number }[]>();
  const missingRoots = new Set<string>();
  for (const task of tasks) {
    const bar = taskBar(task);
    if (!inWindow(bar, startMs)) continue;
    const rootId = task.rootTaskId as string;
    const root = tasksById.get(rootId);
    if (root === undefined) missingRoots.add(rootId);
    const depth = Math.max(0, task.depth - (root?.depth ?? 0));
    const entries = grouped.get(rootId);
    if (entries === undefined) grouped.set(rootId, [{ bar, depth }]);
    else entries.push({ bar, depth });
  }

  const groups: WorkGroup[] = [];
  for (const [rootId, entries] of grouped) {
    const bars = entries.map((entry) => entry.bar);
    groups.push({
      key: `task:${rootId}`,
      initiator: initiatorOf(tasksById.get(rootId)),
      lanes: buildLanes(entries),
      needsYou: bars.some((bar) => bar.tone === "needsYou"),
      active: bars.some((bar) => isActiveTone(bar.tone)),
      lastMs: Math.max(...bars.map((bar) => lastMsOf(bar, nowMs))),
    });
  }

  for (const chat of chats) {
    if (chatCoveredByTask(chat, tasks)) continue;
    const bar = chatBar(chat);
    if (!inWindow(bar, startMs)) continue;
    groups.push({
      key: bar.id,
      initiator: { kind: "you", title: chat.title },
      lanes: [{ botId: chat.botId, depth: 0, bars: [bar] }],
      needsYou: bar.tone === "needsYou",
      active: isActiveTone(bar.tone),
      lastMs: lastMsOf(bar, nowMs),
    });
  }

  const rank = (group: WorkGroup) => (group.needsYou ? 0 : group.active ? 1 : 2);
  groups.sort((left, right) => rank(left) - rank(right) || right.lastMs - left.lastMs);

  const allBars = groups.flatMap((group) => group.lanes.flatMap((lane) => lane.bars));
  const busy = new Set(allBars.map((bar) => bar.botId));
  return {
    startMs,
    nowMs,
    groups,
    needs: allBars
      .filter((bar) => bar.tone === "needsYou")
      .toSorted(
        (left, right) => (left.waitSinceMs ?? left.startMs) - (right.waitSinceMs ?? right.startMs),
      ),
    idleBotIds: botIds.filter((botId) => !busy.has(botId)),
    missingRootIds: [...missingRoots],
  };
}

export interface BarGeometry {
  /** 0 to 1 from the left edge of the window. */
  readonly left: number;
  readonly width: number;
  /** Share of the bar, from its left, that is plain work before a wait. */
  readonly workedShare: number;
  /** The bar began before the window. */
  readonly clippedStart: boolean;
}

/**
 * Where a bar sits in the window. `nowAt` is the share of the width where the
 * now line is drawn; queued work sits to its right.
 */
export function barGeometry(
  bar: WorkBar,
  timeline: Pick<WorkTimeline, "startMs" | "nowMs">,
  nowAt: number,
): BarGeometry {
  if (bar.tone === "queued") {
    return { left: nowAt, width: 1 - nowAt, workedShare: 0, clippedStart: false };
  }
  const span = Math.max(1, timeline.nowMs - timeline.startMs);
  const at = (value: number) =>
    (Math.min(Math.max(value, timeline.startMs), timeline.nowMs) - timeline.startMs) / span;
  const left = at(bar.startMs) * nowAt;
  const right = at(bar.endMs ?? timeline.nowMs) * nowAt;
  const width = Math.max(0, right - left);
  const waitAt = bar.waitSinceMs === null ? right : at(bar.waitSinceMs) * nowAt;
  const workedShare = width === 0 ? 1 : Math.min(1, Math.max(0, (waitAt - left) / width));
  return { left, width, workedShare, clippedStart: bar.startMs < timeline.startMs };
}

/** Evenly spaced tick times across the window, oldest first, ending at now. */
export function timelineTicks(
  timeline: Pick<WorkTimeline, "startMs" | "nowMs">,
  count: number,
): number[] {
  const span = timeline.nowMs - timeline.startMs;
  return Array.from({ length: count + 1 }, (_, index) => timeline.startMs + (span * index) / count);
}

export const WORK_RANGES = [
  { id: "1h", label: "1 h", ms: 60 * 60_000 },
  { id: "4h", label: "4 h", ms: 4 * 60 * 60_000 },
  { id: "today", label: "Today", ms: 24 * 60 * 60_000 },
] as const;
export type WorkRangeId = (typeof WORK_RANGES)[number]["id"];

/** The window for a range; "Today" starts at local midnight. */
export function workRangeMs(range: WorkRangeId, nowMs: number): number {
  if (range !== "today") return WORK_RANGES.find((entry) => entry.id === range)?.ms ?? 0;
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  return Math.max(60 * 60_000, nowMs - midnight.getTime());
}

const TONE_LABELS: Record<WorkTone, string> = {
  working: "Working",
  waitingOthers: "Waiting on others",
  needsYou: "Needs you",
  failed: "Failed",
  done: "Finished",
  stopped: "Stopped",
  queued: "Queued",
};

export const workToneLabel = (tone: WorkTone): string => TONE_LABELS[tone];

export function workInitiatorLabel(initiator: WorkInitiator): string {
  if (initiator.kind === "you") {
    return initiator.title.trim().length > 0
      ? `Started by you · ${initiator.title}`
      : "Started by you";
  }
  if (initiator.kind === "routine") return `Started by ${initiator.title} · routine`;
  return "Started earlier";
}
