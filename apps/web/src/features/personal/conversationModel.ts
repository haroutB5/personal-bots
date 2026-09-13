import type { PendingApproval, PendingUserInput } from "@t3tools/client-runtime/pending-requests";
import type { OrchestrationLatestTurn, OrchestrationSession } from "@t3tools/contracts";

import type { ChatMessage, ProposedPlan } from "~/types";
import type { TimelineEntry, WorkLogEntry } from "~/session-logic";

import { PERSONAL_TIME_ZONE } from "./greeting";

/** Header state for a bot conversation, derived only from session/turn/request state. */
export type ConversationState = "idle" | "working" | "waiting" | "error";

export const CONVERSATION_STATE_LABEL: Record<ConversationState, string> = {
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for you",
  error: "Error",
};

export function deriveConversationState(input: {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly pendingApprovals: ReadonlyArray<PendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
}): ConversationState {
  if (input.pendingApprovals.length > 0 || input.pendingUserInputs.length > 0) return "waiting";
  const status = input.session?.status;
  if (input.latestTurn?.state === "running" || status === "running" || status === "starting") {
    return "working";
  }
  if (status === "error" || input.latestTurn?.state === "error") return "error";
  return "idle";
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

function dayKey(date: Date, timeZone: string): string {
  const parts = formatter(timeZone, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
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
  | { readonly kind: "plan"; readonly id: string; readonly plan: ProposedPlan }
  | {
      readonly kind: "work";
      readonly id: string;
      readonly entries: ReadonlyArray<WorkLogEntry>;
    };

/**
 * Flattens the upstream timeline into chat rows: consecutive work entries
 * fold into one collapsible group, and day dividers are inserted from the
 * entries' real timestamps. System messages are not shown.
 */
export function buildConversationItems(
  entries: ReadonlyArray<TimelineEntry>,
  timeZone: string = PERSONAL_TIME_ZONE,
): ConversationItem[] {
  const items: ConversationItem[] = [];
  let lastAt: Date | null = null;
  let openWork: { id: string; entries: WorkLogEntry[] } | null = null;

  const pushDividerIfNeeded = (createdAt: string) => {
    const at = new Date(createdAt);
    if (Number.isNaN(at.getTime())) return;
    if (
      lastAt === null ||
      dayKey(at, timeZone) !== dayKey(lastAt, timeZone) ||
      at.getTime() - lastAt.getTime() >= DIVIDER_GAP_MS
    ) {
      openWork = null;
      items.push({ kind: "divider", id: `divider:${createdAt}`, at });
    }
    lastAt = at;
  };

  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "system") continue;
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
      items.push({ kind: "message", id: entry.id, message: entry.message });
    } else {
      items.push({ kind: "plan", id: entry.id, plan: entry.proposedPlan });
    }
  }
  return items;
}
