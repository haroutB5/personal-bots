import {
  PERSONAL_TASK_MESSAGE_CONTEXT_KIND,
  PERSONAL_TASK_TERMINAL_STATUSES,
  PersonalTaskMessageMarker,
  type OrchestrationMessageContext,
  type PersonalTask,
  type PersonalTaskSource,
  type PersonalTaskTurnKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { WorkLogEntry } from "~/session-logic";

import { taskStatusLabel } from "./taskPresentation";

/** Resolves a bot id to its display name; null when the bot is unknown. */
export type BotNameOf = (botId: string) => string | null;

export interface ServerTurnChild {
  readonly taskId: string | null;
  readonly botId: string | null;
  readonly title: string;
  readonly status: string | null;
}

/** A user-role turn message the task service wrote, not the user. */
export interface ServerTurn {
  readonly taskId: string;
  readonly attempt: number;
  readonly turn: PersonalTaskTurnKind;
  readonly source: PersonalTaskSource | null;
  readonly title: string;
  readonly delegatorBotId: string | null;
  /** Only known from legacy text ("[Delegated task from Assistant]"). */
  readonly delegatorName: string | null;
  readonly children: ReadonlyArray<ServerTurnChild>;
}

const decodeMarker = Schema.decodeUnknownOption(PersonalTaskMessageMarker);

/** Task turn messages have deterministic ids: `personal-task-<taskId>-<attempt>`. */
const TASK_MESSAGE_ID = /^personal-task-(.+)-(\d+)$/;
const TITLE_LINE = /^Title: (.*)$/m;
const CHILD_RESULT_LINE = /^### (.+) \(([a-z_]+)\)$/gm;
const DELEGATED_HEADER = /^\[Delegated task from (.+?)\]/;

function markerFromContext(context: OrchestrationMessageContext | undefined): ServerTurn | null {
  for (const record of context?.records ?? []) {
    if (record.kind !== PERSONAL_TASK_MESSAGE_CONTEXT_KIND || !("payload" in record)) continue;
    const marker = decodeMarker(record.payload);
    if (Option.isNone(marker)) return null;
    return { ...marker.value, delegatorName: null };
  }
  return null;
}

/**
 * Messages from before the marker existed: the server set their id, and their
 * text starts with one of its fixed headers. Anything else stays a user message.
 */
export function classifyLegacyTaskMessage(message: {
  readonly id: string;
  readonly text: string;
}): ServerTurn | null {
  const idMatch = TASK_MESSAGE_ID.exec(message.id);
  if (idMatch === null) return null;
  const taskId = idMatch[1]!;
  const attempt = Number(idMatch[2]);
  const title = TITLE_LINE.exec(message.text)?.[1]?.trim() ?? "";
  const base = { taskId, attempt, title, delegatorBotId: null, delegatorName: null, children: [] };
  const firstLine = message.text.split("\n", 1)[0] ?? "";
  const retry = /Retry, attempt \d+\./.test(firstLine);
  if (firstLine.startsWith("[Task continuation]")) {
    const children = [...message.text.matchAll(CHILD_RESULT_LINE)].map((match) => ({
      taskId: null,
      botId: null,
      title: match[1]!,
      status: match[2]!,
    }));
    return { ...base, turn: "continuation", source: null, children };
  }
  const turn = retry ? "retry" : "start";
  const delegated = DELEGATED_HEADER.exec(firstLine);
  if (delegated !== null) {
    const name = delegated[1]!;
    return {
      ...base,
      turn,
      source: "delegation",
      delegatorName: name === "another bot" ? null : name,
    };
  }
  if (firstLine.startsWith("[Routine task]")) return { ...base, turn, source: "routine" };
  if (firstLine.startsWith("[Task from you]")) return { ...base, turn, source: "user" };
  return null;
}

/** The server-authored turn behind a message, from its marker or (older rows) its id and header. */
export function readServerTurn(message: {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}): ServerTurn | null {
  if (message.role !== "user") return null;
  return markerFromContext(message.context) ?? classifyLegacyTaskMessage(message);
}

/** Legacy continuations name children by title only; the task feed knows their bots. */
export function resolveTurnChildren(
  turn: ServerTurn,
  tasks: ReadonlyArray<PersonalTask>,
): ReadonlyArray<ServerTurnChild> {
  if (turn.children.every((child) => child.botId !== null)) return turn.children;
  const siblings = tasks.filter((task) => task.parentTaskId === turn.taskId);
  return turn.children.map((child) => {
    if (child.botId !== null) return child;
    const match = siblings.find(
      (task) =>
        task.taskId === child.taskId || (child.taskId === null && task.title === child.title),
    );
    return match === undefined ? child : { ...child, taskId: match.taskId, botId: match.botId };
  });
}

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const CHILD_OUTCOME: Record<string, string> = {
  completed: "finished",
  failed: "failed",
  interrupted: "was interrupted",
  cancelled: "was cancelled",
};

/** One-line text for the compact system row, e.g. "Developer finished: PONG connectivity check". */
export function serverTurnLabel(
  turn: ServerTurn,
  children: ReadonlyArray<ServerTurnChild>,
  nameOf: BotNameOf,
): string {
  const title = turn.title.trim();
  const withTitle = (prefix: string) => (title.length > 0 ? `${prefix}: ${title}` : prefix);
  switch (turn.turn) {
    case "continuation": {
      if (children.length === 0) return withTitle("Task resumed");
      if (children.length === 1) {
        const child = children[0]!;
        const name = (child.botId === null ? null : nameOf(child.botId)) ?? "A bot";
        const outcome = CHILD_OUTCOME[child.status ?? "completed"] ?? "finished";
        return `${name} ${outcome}: ${child.title}`;
      }
      const names = [
        ...new Set(
          children.flatMap((child) => {
            const name = child.botId === null ? null : nameOf(child.botId);
            return name === null ? [] : [name];
          }),
        ),
      ];
      return names.length === 0
        ? `${children.length} delegated tasks finished`
        : `${joinNames(names)} finished ${children.length} tasks`;
    }
    case "retry":
      return withTitle(`Retry, attempt ${turn.attempt}`);
    case "start": {
      if (turn.source === "routine") return withTitle("Routine");
      if (turn.source === "delegation") {
        const from =
          turn.delegatorName ??
          (turn.delegatorBotId === null ? null : nameOf(turn.delegatorBotId)) ??
          "another bot";
        return withTitle(`Task from ${from}`);
      }
      return withTitle("Task");
    }
  }
}

// ---------------------------------------------------------------------------
// Delegation cards
// ---------------------------------------------------------------------------

const isTerminal = (task: PersonalTask) => PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status);

export const taskCreatedMs = (task: PersonalTask) => DateTime.toEpochMillis(task.createdAt);

/** Tasks delegated from any task that ran in this thread, oldest first. */
export function delegatedChildren(
  threadId: string,
  tasks: ReadonlyArray<PersonalTask>,
): PersonalTask[] {
  const parentIds = new Set(
    tasks.filter((task) => task.threadId === threadId).map((task) => task.taskId as string),
  );
  if (parentIds.size === 0) return [];
  return tasks
    .filter((task) => task.parentTaskId !== null && parentIds.has(task.parentTaskId))
    .toSorted((left, right) => taskCreatedMs(left) - taskCreatedMs(right));
}

export type DelegationTone = "neutral" | "live" | "review" | "done" | "error";

export interface DelegationStep {
  readonly id: string;
  readonly label: string;
  readonly state: "done" | "current" | "failed";
}

export interface DelegationCardModel {
  readonly tone: DelegationTone;
  readonly status: string;
  /** Real child activity, only while the child runs; never invented. */
  readonly steps: ReadonlyArray<DelegationStep>;
  /** Result summary, or the reason the child stopped. */
  readonly detail: string | null;
  readonly canCancel: boolean;
}

const MAX_STEPS = 3;

/** The latest turn's work entries: an earlier attempt's activity is not this run's progress. */
function currentTurnEntries(entries: ReadonlyArray<WorkLogEntry>): ReadonlyArray<WorkLogEntry> {
  const visible = entries.filter((entry) => entry.tone !== "thinking");
  const lastTurn = visible.at(-1)?.turnId;
  if (lastTurn === undefined || lastTurn === null) return visible;
  return visible.filter((entry) => entry.turnId === lastTurn);
}

/**
 * Card state from the child task and its thread's live work log. The status
 * row always mirrors `task.status`; steps appear only while it runs, and only
 * when the child's thread has actually recorded activity.
 */
export function deriveDelegationCard(input: {
  readonly task: PersonalTask;
  readonly entries: ReadonlyArray<WorkLogEntry>;
  readonly labelOf: (entry: WorkLogEntry) => string;
  /** "Waiting for Researcher" when the child is itself waiting on a bot. */
  readonly waitingFor?: string | null;
}): DelegationCardModel {
  const { task } = input;
  const canCancel = !isTerminal(task);
  switch (task.status) {
    case "running": {
      const recent = currentTurnEntries(input.entries).slice(-MAX_STEPS);
      const steps = recent.map((entry, index): DelegationStep => ({
        id: entry.id,
        label: input.labelOf(entry),
        state: entry.tone === "error" ? "failed" : index === recent.length - 1 ? "current" : "done",
      }));
      return { tone: "live", status: "Working", steps, detail: null, canCancel };
    }
    case "queued":
      return { tone: "neutral", status: "Queued", steps: [], detail: null, canCancel };
    case "waiting_for_user":
      return { tone: "review", status: "Needs your input", steps: [], detail: null, canCancel };
    case "waiting_for_browser":
      return { tone: "review", status: "Needs the browser", steps: [], detail: null, canCancel };
    case "waiting_for_agent":
      return {
        tone: "neutral",
        status: input.waitingFor ?? taskStatusLabel(task.status),
        steps: [],
        detail: null,
        canCancel,
      };
    case "rate_limited":
      return {
        tone: "review",
        status: taskStatusLabel(task.status),
        steps: [],
        detail: task.errorMessage,
        canCancel,
      };
    case "completed":
      return {
        tone: "done",
        status: "Done",
        steps: [],
        detail: task.result?.summary.trim() || null,
        canCancel,
      };
    case "failed":
    case "interrupted":
      return {
        tone: "error",
        status: taskStatusLabel(task.status),
        steps: [],
        detail: task.errorMessage ?? "No reason was reported.",
        canCancel,
      };
    case "cancelled":
      return {
        tone: "neutral",
        status: "Cancelled",
        steps: [],
        detail: task.errorMessage,
        canCancel,
      };
  }
}

// ---------------------------------------------------------------------------
// Waiting parents
// ---------------------------------------------------------------------------

function waitingText(names: ReadonlyArray<string>): string {
  if (names.length === 0) return "Waiting on another bot";
  if (names.length <= 2) return `Waiting for ${joinNames(names)}`;
  return `Waiting for ${names.length} bots`;
}

/**
 * "Waiting for Developer" per thread whose task is parked on delegated work,
 * naming the bots of its unfinished children. Two parked tasks in one thread
 * (two chat turns that both delegated) merge their names.
 */
export function waitingLabelsByThread(
  tasks: ReadonlyArray<PersonalTask>,
  nameOf: BotNameOf,
): ReadonlyMap<string, string> {
  const waiting = tasks.filter(
    (task) => task.status === "waiting_for_agent" && task.threadId !== null,
  );
  if (waiting.length === 0) return new Map();
  const openChildrenByParent = new Map<string, PersonalTask[]>();
  for (const task of tasks) {
    if (task.parentTaskId === null || isTerminal(task)) continue;
    const list = openChildrenByParent.get(task.parentTaskId);
    if (list === undefined) openChildrenByParent.set(task.parentTaskId, [task]);
    else list.push(task);
  }
  const namesByThread = new Map<string, Set<string>>();
  for (const parent of waiting) {
    let names = namesByThread.get(parent.threadId!);
    if (names === undefined) {
      names = new Set();
      namesByThread.set(parent.threadId!, names);
    }
    for (const child of openChildrenByParent.get(parent.taskId) ?? []) {
      const name = nameOf(child.botId);
      if (name !== null) names.add(name);
    }
  }
  return new Map(
    [...namesByThread].map(([threadId, names]) => [threadId, waitingText([...names])] as const),
  );
}
