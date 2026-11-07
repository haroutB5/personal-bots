import type { PersonalBot } from "@t3tools/contracts";
import type { BulkChatAction, ChatSection } from "@hbots/personal-client/bots/chatSelection";
import {
  allChatsSelected,
  selectedCountLabel,
  toggleChatSelection,
  visibleSelection,
} from "@hbots/personal-client/bots/chatSelection";
import { isChatPinned } from "@hbots/personal-client/bots/chatState";
import {
  isThreadLive,
  isThreadRateLimited,
  threadNeedsAttention,
} from "@hbots/personal-client/bots/botSummaries";
import { isChatUnread, type ChatSeenState } from "@hbots/personal-client/bots/unreadChats";
import type { BotThreadRow } from "@hbots/personal-client/feed/botThreadRows";

export type ThreadsScreenState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "notFound" }
  | { readonly kind: "ready"; readonly bot: PersonalBot };

export function threadsScreenState(
  botId: string,
  list: {
    readonly bots: ReadonlyArray<PersonalBot> | null;
    readonly error: string | null;
  },
): ThreadsScreenState {
  const bot = list.bots?.find((candidate) => candidate.botId === botId);
  if (bot !== undefined) return { kind: "ready", bot };
  if (list.bots !== null) return { kind: "notFound" };
  if (list.error !== null) return { kind: "error", message: list.error };
  return { kind: "loading" };
}

export const BOT_THREADS_GONE_MESSAGE = "This bot no longer exists.";

/** Select mode holds one section at a time, so Select all never reaches the other. */
export interface ThreadSelection {
  readonly section: ChatSection;
  readonly ids: ReadonlySet<string>;
}

export function startSelection(section: ChatSection, first: string | null): ThreadSelection {
  return { section, ids: new Set(first === null ? [] : [first]) };
}

export function toggleThread(
  selection: ThreadSelection | null,
  threadId: string,
): ThreadSelection | null {
  return selection === null
    ? null
    : { ...selection, ids: toggleChatSelection(selection.ids, threadId) };
}

export function toggleAllThreads(
  selection: ThreadSelection | null,
  sectionIds: ReadonlyArray<string>,
): ThreadSelection | null {
  if (selection === null) return null;
  return {
    ...selection,
    ids: new Set(allChatsSelected(selection.ids, sectionIds) ? [] : sectionIds),
  };
}

/** Done: back to the plain list. Refused chats stay selected for another try. */
export function selectionAfterBulk(
  section: ChatSection,
  failedIds: ReadonlyArray<string>,
): ThreadSelection | null {
  return failedIds.length === 0 ? null : { section, ids: new Set(failedIds) };
}

export interface SelectionView {
  readonly sectionRows: ReadonlyArray<BotThreadRow>;
  readonly sectionIds: ReadonlyArray<string>;
  /** The selected chats still in the section, in list order. */
  readonly chosen: ReadonlyArray<string>;
  readonly everySelected: boolean;
  readonly allChosenPinned: boolean;
  readonly countLabel: string;
}

export function selectionView(
  selection: ThreadSelection,
  rows: {
    readonly active: ReadonlyArray<BotThreadRow>;
    readonly archived: ReadonlyArray<BotThreadRow>;
  },
): SelectionView {
  const sectionRows = selection.section === "archived" ? rows.archived : rows.active;
  const sectionIds = sectionRows.map((row) => row.link.threadId as string);
  const chosen = visibleSelection(selection.ids, sectionIds);
  return {
    sectionRows,
    sectionIds,
    chosen,
    everySelected: allChatsSelected(selection.ids, sectionIds),
    allChosenPinned:
      chosen.length > 0 &&
      sectionRows
        .filter((row) => chosen.includes(row.link.threadId))
        .every((row) => isChatPinned(row.link)),
    countLabel: selectedCountLabel(chosen.length),
  };
}

/** How many of the chosen chats are working, for the delete confirm. */
export function workingCount(
  rows: ReadonlyArray<BotThreadRow>,
  chosen: ReadonlyArray<string>,
): number {
  return rows.filter((row) => chosen.includes(row.link.threadId) && isThreadLive(row.shell)).length;
}

export interface BulkBarButton {
  readonly action: BulkChatAction;
  readonly label: string;
  readonly danger: boolean;
}

export function bulkBarButtons(
  section: ChatSection,
  allChosenPinned: boolean,
): ReadonlyArray<BulkBarButton> {
  switch (section) {
    case "active":
      return [
        { action: "archive", label: "Archive", danger: false },
        allChosenPinned
          ? { action: "unpin", label: "Unpin", danger: false }
          : { action: "pin", label: "Pin", danger: false },
        { action: "snooze", label: "Snooze", danger: false },
        { action: "markUnread", label: "Mark unread", danger: false },
        { action: "delete", label: "Delete", danger: true },
      ];
    case "archived":
      return [
        { action: "unarchive", label: "Unarchive", danger: false },
        { action: "delete", label: "Delete", danger: true },
      ];
    default: {
      const unreachable: never = section;
      return unreachable;
    }
  }
}

export interface ListMenuItem {
  readonly section: ChatSection;
  readonly label: string;
  readonly disabled: boolean;
}

export function listMenuItems(
  activeCount: number,
  archivedCount: number,
): ReadonlyArray<ListMenuItem> {
  return [
    { section: "active", label: "Select chats", disabled: activeCount === 0 },
    ...(archivedCount > 0
      ? [{ section: "archived" as const, label: "Select archived chats", disabled: false }]
      : []),
  ];
}

/** Archived chats of the bot: the server's count when it omits them from the list, else the rows. */
export function archivedChatCount(
  botId: string,
  archivedCounts: Readonly<Record<string, number>> | undefined,
  archivedRows: number,
): number {
  return archivedCounts === undefined ? archivedRows : (archivedCounts[botId] ?? 0);
}

export type ArchivedLoad = "ready" | "loading" | "error";

export function archivedLoad(input: {
  readonly lazy: boolean;
  readonly isSuccess: boolean;
  readonly error: string | null;
}): ArchivedLoad {
  if (!input.lazy || input.isSuccess) return "ready";
  return input.error === null ? "loading" : "error";
}

export function activeEmptyText(botName: string, snoozedCount: number): string {
  return snoozedCount > 0
    ? `Every chat with ${botName} is snoozed.`
    : `No chats with ${botName} yet.`;
}

export function archivedHeading(count: number): string {
  return `Archived chats (${count})`;
}

export function snoozedHeading(count: number): string {
  return `Snoozed (${count})`;
}

/** The unread dots: chats the bot replied in since this device last had them open. */
export function unreadThreadIds(
  rows: ReadonlyArray<BotThreadRow>,
  seen: ChatSeenState,
): ReadonlySet<string> {
  return new Set(
    rows
      .filter((row) => isChatUnread(row.link, seen, row.shell))
      .map((row) => row.link.threadId as string),
  );
}

/** Changes when a listed chat finishes a turn, which is when the list is read again. */
export function turnsSettledKey(rows: ReadonlyArray<BotThreadRow>): string {
  return rows
    .map((row) => `${row.link.threadId}:${row.shell.latestTurn?.completedAt ?? ""}`)
    .join("|");
}

/** Wrapup acts on the most recent open chat, the one "New chat" would supersede. */
export function newestRow(rows: ReadonlyArray<BotThreadRow>): BotThreadRow | null {
  return rows.reduce<BotThreadRow | null>(
    (newest, row) => (newest === null || row.updatedMs > newest.updatedMs ? row : newest),
    null,
  );
}

export function wrapupDisabled(input: {
  readonly hasChat: boolean;
  readonly offline: boolean;
  readonly sending: boolean;
}): boolean {
  return !input.hasChat || input.offline || input.sending;
}

export const WRAPUP_FAILED_MESSAGE = "Couldn't start the wrapup. Try again.";

export type RowStatus =
  | { readonly kind: "none" }
  | { readonly kind: "needsYou"; readonly label: "Needs you" }
  | { readonly kind: "rateLimited"; readonly label: "Rate limited" }
  | { readonly kind: "working"; readonly label: "Working" };

export function rowStatus(row: BotThreadRow): RowStatus {
  if (threadNeedsAttention(row.shell)) return { kind: "needsYou", label: "Needs you" };
  if (isThreadRateLimited(row.shell)) return { kind: "rateLimited", label: "Rate limited" };
  if (isThreadLive(row.shell)) return { kind: "working", label: "Working" };
  return { kind: "none" };
}

/** What a screen reader hears for an open chat row. */
export function rowAccessibilityLabel(row: BotThreadRow, unread: boolean): string {
  return [
    row.shell.title,
    ...(isChatPinned(row.link) ? ["pinned"] : []),
    ...(unread ? ["unread"] : []),
    ...(rowStatus(row).kind === "none"
      ? []
      : [rowStatus(row).kind === "working" ? "working" : "needs attention"]),
  ].join(", ");
}

/** A browser holds a timer's delay in 32 bits; Hermes does too, so a longer wait is made in steps. */
export const MAX_TIMER_MS = 2_147_483_647;
/** A little after the wake time, so the server has crossed it too when the list is asked. */
export const WAKE_SLACK_MS = 400;

export type WakeStep = { readonly kind: "wait"; readonly ms: number } | { readonly kind: "fire" };

export function wakeStep(wakeAt: number, nowMs: number): WakeStep {
  const wait = wakeAt + WAKE_SLACK_MS - nowMs;
  return wait > 0 ? { kind: "wait", ms: Math.min(wait, MAX_TIMER_MS) } : { kind: "fire" };
}

export interface TurnsBaseline {
  readonly baseline: string | null;
  readonly refetch: boolean;
}

/** A refetch is due when the key changes after its first non-empty value. */
export function turnsBaselineStep(baseline: string | null, key: string): TurnsBaseline {
  if (key === "") return { baseline, refetch: false };
  if (baseline === null || baseline === key) return { baseline: key, refetch: false };
  return { baseline: key, refetch: true };
}

export type RowKind = "active" | "snoozed" | "archived";
export type RowSwipeKey = "pin" | "unpin" | "snooze" | "archive" | "unarchive" | "delete";

export interface RowSwipeAction {
  readonly key: RowSwipeKey;
  readonly label: string;
  readonly tone: "neutral" | "accent" | "danger";
}

export interface RowSwipeSpec {
  /** Revealed by swiping right. */
  readonly leading: ReadonlyArray<RowSwipeAction>;
  /** Revealed by swiping left. */
  readonly trailing: ReadonlyArray<RowSwipeAction>;
}

/** Pin and Snooze only on open chats; a snoozed one wakes first. */
export function rowSwipeSpec(kind: RowKind, pinned: boolean): RowSwipeSpec {
  const remove: RowSwipeAction = { key: "delete", label: "Delete", tone: "danger" };
  switch (kind) {
    case "active":
      return {
        leading: [
          pinned
            ? { key: "unpin", label: "Unpin", tone: "accent" }
            : { key: "pin", label: "Pin", tone: "accent" },
          { key: "snooze", label: "Snooze", tone: "neutral" },
        ],
        trailing: [{ key: "archive", label: "Archive", tone: "neutral" }, remove],
      };
    case "snoozed":
      return {
        leading: [],
        trailing: [{ key: "archive", label: "Archive", tone: "neutral" }, remove],
      };
    case "archived":
      return {
        leading: [],
        trailing: [{ key: "unarchive", label: "Unarchive", tone: "neutral" }, remove],
      };
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

export interface BulkNotice {
  readonly text: string;
  readonly failed: boolean;
}

export const LOAD_FAILED_MESSAGE = "Could not load chats. Try again";
export const ARCHIVED_LOADING_TEXT = "Loading archived chats…";
export const ARCHIVED_FAILED_TEXT = "Could not load archived chats.";
export const NO_CHATS_HERE_TEXT = "No chats here.";

/** The pause between a turn settling and the list being read again (one read for a burst). */
export const TURNS_SETTLED_REFETCH_MS = 400;

/** A plain bulk result fades after a while; one with failures stays until the next action. */
export const NOTICE_FADE_MS = 6000;
