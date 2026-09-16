import type { PendingApproval, PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  PersonalBrowserStatus,
  PersonalTask,
} from "@t3tools/contracts";

import type { ChatMessage, ProposedPlan } from "~/types";
import type { TimelineEntry, WorkLogEntry } from "~/session-logic";

import { readServerTurn, type ServerTurn, taskCreatedMs } from "./delegationModel";
import { PERSONAL_TIME_ZONE } from "./greeting";

/**
 * Header state for a bot conversation, derived only from session/turn/request
 * state, plus the thread's task when it is parked on delegated work.
 */
export type ConversationState =
  | "idle"
  | "needs_help"
  | "working"
  | "waiting"
  | "delegating"
  | "rate_limited"
  | "retrying"
  | "error";

export const CONVERSATION_STATE_LABEL: Record<ConversationState, string> = {
  idle: "Idle",
  needs_help: "Needs your help",
  working: "Working",
  waiting: "Waiting for you",
  // The screen names the bots ("Waiting for Developer") when it knows them.
  delegating: "Waiting on another bot",
  rate_limited: "Rate limited",
  retrying: "Retrying",
  error: "Error",
};

/**
 * The provider wait a session is stuck on, if any. A rate limit also outlives
 * the turn that failed on it (the session keeps its reset time); a transport
 * retry only matters while the turn still runs.
 */
export function providerWaitState(
  session: OrchestrationSession | null | undefined,
): "rate_limited" | "retrying" | null {
  const retry = session?.providerRetry;
  if (retry === undefined || session === null || session === undefined) return null;
  const running = session.status === "running" || session.status === "starting";
  if (retry.kind === "rate_limited" && (running || session.status === "error")) {
    return "rate_limited";
  }
  return retry.kind === "retrying" && running ? "retrying" : null;
}

export function deriveConversationState(input: {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly browserStatus?: PersonalBrowserStatus | null;
  readonly threadId?: string;
  /** The thread's task is parked waiting for delegated work (`waiting_for_agent`). */
  readonly waitingForAgent?: boolean;
}): ConversationState {
  if (
    input.threadId !== undefined &&
    input.browserStatus?.helpRequest?.threadId === input.threadId
  ) {
    return "needs_help";
  }
  if (input.pendingApprovals.length > 0 || input.pendingUserInputs.length > 0) return "waiting";
  const wait = providerWaitState(input.session);
  if (wait !== null) return wait;
  const status = input.session?.status;
  if (input.latestTurn?.state === "running" || status === "running" || status === "starting") {
    return "working";
  }
  // The delegating turn ended cleanly; its outcome is still open.
  if (input.waitingForAgent === true) return "delegating";
  if (status === "error" || input.latestTurn?.state === "error") return "error";
  return "idle";
}

/**
 * Header state text. Provider waits say when the provider will try again, in
 * London time (weekday added when it is not today), or that it did not say:
 * "Rate limited · retry ~10:47", "Rate limited · reset not reported".
 */
export function conversationStateLabel(
  state: ConversationState,
  session: OrchestrationSession | null,
  now: Date,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  if (state !== "rate_limited" && state !== "retrying") return CONVERSATION_STATE_LABEL[state];
  const retryAt = session?.providerRetry?.retryAt;
  const at = retryAt === undefined ? Number.NaN : Date.parse(retryAt);
  if (state === "rate_limited") {
    return Number.isFinite(at)
      ? `Rate limited · retry ~${formatRetryTime(new Date(at), now, timeZone)}`
      : "Rate limited · reset not reported";
  }
  return Number.isFinite(at) && at > now.getTime()
    ? `Retrying · next ~${formatRetryTime(new Date(at), now, timeZone)}`
    : "Retrying";
}

function formatRetryTime(at: Date, now: Date, timeZone: string): string {
  const time = formatter(timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    at,
  );
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return time;
  return `${formatter(timeZone, { weekday: "short" }).format(at)} ${time}`;
}

export interface FriendlyTurnError {
  /** Plain sentence for the chat. */
  readonly message: string;
  /** The provider's own first line, stack trace removed, for a "Details" toggle. */
  readonly detail: string | null;
}

const GENERIC_TURN_FAILURE = "The last reply failed. Send your message again.";
const DETAIL_MAX = 200;

/**
 * A session error as the owner should read it: never a raw exception or stack
 * trace. Known failure kinds get a plain sentence; everything else a generic
 * one. The original first line survives as `detail`.
 *
 * `fallback` replaces the generic sentence for callers whose failure is not a
 * failed reply (answering a question, closing one), so the unrecognised case
 * still names what actually went wrong.
 */
export function friendlyTurnError(
  raw: string,
  fallback: string = GENERIC_TURN_FAILURE,
): FriendlyTurnError {
  const firstLine =
    raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const withoutStack = firstLine
    .replace(/\s+at\s+\S+\s+\(file:\/\/.*$/i, "")
    .replace(/\s+at\s+file:\/\/.*$/i, "")
    .trim();
  const detail =
    withoutStack.length === 0 || withoutStack === "The last turn failed."
      ? null
      : withoutStack.length > DETAIL_MAX
        ? `${withoutStack.slice(0, DETAIL_MAX)}…`
        : withoutStack;

  const text = raw.toLowerCase();
  let message = fallback;
  if (/session limit|usage limit|rate[_ ]limit|\b429\b|hit your .*limit/.test(text)) {
    const reset = /resets?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s?(?:am|pm)?)/i.exec(raw)?.[1];
    message =
      reset === undefined
        ? "Usage limit reached. Try again later."
        : `Usage limit reached. It resets at ${reset}.`;
  } else if (/thread is closed|sessionclosed|session (?:was )?(?:closed|stopped)/.test(text)) {
    message = "This chat's session ended. Send a message to start it again.";
  } else if (
    /not (?:logged|signed) in|unauthori[sz]ed|\b401\b|authentication (?:failed|required)|please run \/login/.test(
      text,
    )
  ) {
    message = "The provider isn't signed in on your computer.";
  } else if (/timed? ?out|etimedout/.test(text)) {
    message = "The reply took too long and was stopped. Try again.";
  } else if (/enotfound|econnrefused|econnreset|fetch failed|network error/.test(text)) {
    message = "Couldn't reach the provider. Check your computer's internet connection.";
  }
  return { message, detail: detail === message ? null : detail };
}

export type ConversationHeaderName =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly name: string };

/**
 * The header names the bot, never the thread: while the bots list is still
 * loading (a cold deep link) the header is a skeleton, and a bot that no
 * longer exists reads "Chat".
 */
export function resolveConversationHeaderName(input: {
  readonly botName: string | null;
  readonly botsLoaded: boolean;
}): ConversationHeaderName {
  if (input.botName !== null) return { status: "ready", name: input.botName };
  return input.botsLoaded ? { status: "ready", name: "Chat" } : { status: "loading" };
}

const TIME_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let cached = TIME_FORMAT_CACHE.get(key);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat("en-GB", { timeZone, ...options });
    TIME_FORMAT_CACHE.set(key, cached);
  }
  return cached;
}

// `formatToParts` costs microseconds and runs twice per entry per rebuild;
// keyed on a 15-minute UTC bucket plus zone it is a lookup for everything
// but new buckets.
const DAY_KEY_CACHE = new Map<string, string>();
const DAY_KEY_CACHE_LIMIT = 1_000;

function dayKey(date: Date, timeZone: string): string {
  // Every real zone offset is a multiple of 15 minutes, so all instants in
  // one 15-minute UTC bucket fall on the same local day.
  const cacheKey = `${timeZone}|${Math.floor(date.getTime() / 900_000)}`;
  const cached = DAY_KEY_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const parts = formatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const key = `${part("year")}-${part("month")}-${part("day")}`;
  if (DAY_KEY_CACHE.size >= DAY_KEY_CACHE_LIMIT) DAY_KEY_CACHE.clear();
  DAY_KEY_CACHE.set(cacheKey, key);
  return key;
}

function previousDayKey(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Today, 21:38", "Yesterday, 09:05", "12 Sep, 14:00" or "12 Sep 2025, 14:00". */
export function formatDayDivider(
  then: Date,
  now: Date,
  timeZone: string = PERSONAL_TIME_ZONE,
): string {
  const time = formatter(timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    then,
  );
  const thenDay = dayKey(then, timeZone);
  const nowDay = dayKey(now, timeZone);
  if (thenDay === nowDay) return `Today, ${time}`;
  if (thenDay === previousDayKey(nowDay)) return `Yesterday, ${time}`;
  const [year, month, day] = thenDay.split("-").map(Number);
  const label = `${day} ${SHORT_MONTHS[month! - 1]}`;
  return thenDay.slice(0, 4) === nowDay.slice(0, 4)
    ? `${label}, ${time}`
    : `${label} ${year}, ${time}`;
}

/** A new divider starts each London day, and after an hour of silence. */
const DIVIDER_GAP_MS = 60 * 60_000;

export type ConversationItem =
  | { readonly kind: "divider"; readonly id: string; readonly at: Date }
  | { readonly kind: "message"; readonly id: string; readonly message: ChatMessage }
  /** A turn the task service wrote in the user's role; a compact system row. */
  | {
      readonly kind: "system-turn";
      readonly id: string;
      readonly message: ChatMessage;
      readonly turn: ServerTurn;
    }
  | { readonly kind: "plan"; readonly id: string; readonly plan: ProposedPlan }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly entries: ReadonlyArray<WorkLogEntry>;
    }
  /** A task delegated from this thread, shown as a live card. */
  | { readonly kind: "delegation"; readonly id: string; readonly task: PersonalTask };

/**
 * Flattens the upstream timeline into chat rows: consecutive work entries
 * fold into one collapsible group, and day dividers are inserted from the
 * entries' real timestamps. System messages are not shown; turns the task
 * service authored become system rows instead of the user's bubble.
 */
export function buildConversationItems(
  entries: ReadonlyArray<TimelineEntry>,
  options: {
    readonly timeZone?: string;
    /** Settings > Chat > "Show tool steps". Off by default: no work rows at all. */
    readonly showToolSteps?: boolean;
  } = {},
): ConversationItem[] {
  const timeZone = options.timeZone ?? PERSONAL_TIME_ZONE;
  const showToolSteps = options.showToolSteps ?? false;
  const items: ConversationItem[] = [];
  /** The last row actually rendered: day dividers are about visible gaps. */
  let lastAt: Date | null = null;
  /**
   * The last entry of any kind, hidden work included. A bot that worked for an
   * hour was not silent, so its reply must not inherit a "gap" divider just
   * because the steps behind it are hidden.
   */
  let lastActivityAt: Date | null = null;
  let openWork: { id: string; entries: WorkLogEntry[] } | null = null;

  const noteActivity = (createdAt: string) => {
    const at = new Date(createdAt);
    if (!Number.isNaN(at.getTime())) lastActivityAt = at;
  };

  const pushDividerIfNeeded = (createdAt: string) => {
    const at = new Date(createdAt);
    if (Number.isNaN(at.getTime())) return;
    const since = lastActivityAt ?? lastAt;
    if (
      lastAt === null ||
      dayKey(at, timeZone) !== dayKey(lastAt, timeZone) ||
      (since !== null && at.getTime() - since.getTime() >= DIVIDER_GAP_MS)
    ) {
      openWork = null;
      items.push({ kind: "divider", id: `divider:${createdAt}`, at });
    }
    lastAt = at;
    lastActivityAt = at;
  };

  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "system") continue;
    // Checkpoints are developer plumbing (undo snapshots of a git workspace);
    // a bot chat never shows their steps, failed or not. With "Show tool steps"
    // off (the default) every work entry is dropped the same way, so no work
    // group is ever created and the transcript is just what was said.
    if (
      entry.kind === "work" &&
      (!showToolSteps || entry.entry.sourceActivityKind?.startsWith("checkpoint.") === true)
    ) {
      noteActivity(entry.createdAt);
      continue;
    }
    pushDividerIfNeeded(entry.createdAt);
    if (entry.kind === "work") {
      if (openWork === null) {
        openWork = { id: `work:${entry.id}`, entries: [] };
        items.push({ kind: "work", id: openWork.id, entries: openWork.entries });
      }
      openWork.entries.push(entry.entry);
      continue;
    }
    openWork = null;
    if (entry.kind === "message") {
      const turn = readServerTurn(entry.message);
      items.push(
        turn === null
          ? { kind: "message", id: entry.id, message: entry.message }
          : { kind: "system-turn", id: entry.id, message: entry.message, turn },
      );
    } else {
      items.push({ kind: "plan", id: entry.id, plan: entry.proposedPlan });
    }
  }
  return items;
}

/** A new turn starts here: the user spoke, the task service did, or a new day began. */
export function isTurnBoundary(item: ConversationItem): boolean {
  return (
    item.kind === "divider" ||
    item.kind === "system-turn" ||
    (item.kind === "message" && item.message.role === "user")
  );
}

function itemTimeMs(item: ConversationItem): number {
  switch (item.kind) {
    case "divider":
      return item.at.getTime();
    case "message":
    case "system-turn":
      return Date.parse(item.message.createdAt);
    case "plan":
      return Date.parse(item.plan.createdAt);
    case "work":
      return Date.parse(item.entries.at(-1)?.createdAt ?? "");
    case "delegation":
      return taskCreatedMs(item.task);
  }
}

/**
 * Puts each delegated child's card at the end of the turn that created it:
 * after the last row written before the child existed, then past the rest of
 * that turn (its reply), stopping at the next turn. A child older than every
 * loaded row (earlier turns not paged in) goes first.
 */
export function placeDelegationCards(
  items: ReadonlyArray<ConversationItem>,
  children: ReadonlyArray<PersonalTask>,
): ConversationItem[] {
  if (children.length === 0) return [...items];
  const placed = [...items];
  // Times are parsed once per item, not once per item per child.
  const times = items.map(itemTimeMs);
  for (const task of children.toSorted(
    (left, right) => taskCreatedMs(left) - taskCreatedMs(right),
  )) {
    const createdMs = taskCreatedMs(task);
    let anchor = -1;
    for (let index = 0; index < placed.length; index += 1) {
      const at = times[index]!;
      if (Number.isFinite(at) && at <= createdMs) anchor = index;
    }
    let end = anchor;
    if (anchor >= 0) {
      while (end + 1 < placed.length && !isTurnBoundary(placed[end + 1]!)) end += 1;
    }
    placed.splice(end + 1, 0, { kind: "delegation", id: `delegation:${task.taskId}`, task });
    times.splice(end + 1, 0, createdMs);
  }
  return placed;
}
