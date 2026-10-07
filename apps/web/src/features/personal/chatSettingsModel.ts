import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { PersonalBotThread } from "@t3tools/contracts";

import { isThreadLive, isThreadRateLimited } from "./botSummaries";
import { chatActivityMs } from "./chatActivity";
import { type ChatChipKind, type ChatChipState, chatChipState, stateWords } from "./chatChipRows";
import { isChatPinned, snoozeEndMs, whenWords } from "./chatState";
import { conversationChatTitle } from "./ConversationHeaderName";
import { formatRelativeTime } from "./relativeTime";

/**
 * What the chat settings sheet shows for one chat, worked out in one place so
 * the sheet, the chip's dot and the tests agree: who the chat is (title, state
 * words, last message), which rows apply and which are disabled with a reason.
 * Pure: the screen reads the chat's link and shell, this decides.
 */

const UNTITLED = "New chat";

export type ChatSettingsRowId =
  | "pin"
  | "unpin"
  | "snooze"
  | "wake"
  | "markUnread"
  | "rename"
  | "wrapup"
  | "archive"
  | "unarchive"
  | "delete";

export interface ChatSettingsTarget {
  readonly threadId: string;
  /** The chat's own title, or "New chat". */
  readonly title: string;
  readonly kind: ChatChipKind;
  /** The chat that is open on the screen: its actions leave or stay as the menu always did. */
  readonly isOpenChat: boolean;
  readonly pinned: boolean;
  readonly archived: boolean;
  /** When the snooze ends, while it is still asleep. */
  readonly snoozedUntilMs: number | null;
  readonly unread: boolean;
  readonly state: ChatChipState;
  /** The state in words ("needs you", "working", "waiting on Frontend"), or null when idle. */
  readonly words: string | null;
  /** A turn is running in this chat (or parked on a provider wait). */
  readonly working: boolean;
  readonly activityMs: number;
  /** The one-line last message, or null when there is none or the bot hides previews. */
  readonly preview: string | null;
}

export function buildChatSettingsTarget(input: {
  readonly threadId: string;
  readonly currentThreadId: string;
  readonly kind: ChatChipKind;
  readonly link: PersonalBotThread;
  readonly shell: EnvironmentThreadShell;
  readonly waitingLabel: string | null;
  /** Unread for the owner (never true for the open chat). */
  readonly unread: boolean;
  readonly hidePreviews: boolean;
  /** The open chat's own busy flag (it counts a provider wait the shell may not show). */
  readonly openChatBusy: boolean;
  readonly nowMs: number;
}): ChatSettingsTarget {
  const isOpenChat = input.threadId === input.currentThreadId;
  const { link, shell } = input;
  const archived = link.archivedAt !== null || shell.archivedAt !== null;
  const state = chatChipState({
    shell,
    waiting: input.waitingLabel !== null,
    unread: input.unread,
  });
  const text = input.hidePreviews
    ? ""
    : (link.newestMessage?.text ?? "").replace(/\s+/g, " ").trim();
  return {
    threadId: input.threadId,
    title: conversationChatTitle(shell.title) ?? UNTITLED,
    kind: archived && input.kind === "chat" ? "archived" : input.kind,
    isOpenChat,
    pinned: isChatPinned(link),
    archived,
    snoozedUntilMs: snoozeEndMs(link, input.nowMs),
    unread: input.unread,
    state,
    words: stateWords(state, shell, input.waitingLabel),
    working:
      (isOpenChat && input.openChatBusy) || isThreadLive(shell) || isThreadRateLimited(shell),
    activityMs: chatActivityMs(shell, link),
    preview: text === "" || link.newestMessage?.hidden === true ? null : text,
  };
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The chat list's short time, as it reads after a dot: "now", "6m", "2h", "yesterday", "12 Sep". */
function shortWhen(activityMs: number, nowMs: number): string {
  const when = formatRelativeTime(activityMs, nowMs);
  return when === "Now" || when === "Yesterday" ? when.toLowerCase() : when;
}

/** "Last message 2h ago", "Last message just now", "Last message yesterday", "Last message 12 Sep". */
function lastMessageWords(activityMs: number, nowMs: number): string {
  const when = formatRelativeTime(activityMs, nowMs);
  if (when === "Now") return "Last message just now";
  if (when === "Yesterday") return "Last message yesterday";
  return /^\d+[mh]$/.test(when) ? `Last message ${when} ago` : `Last message ${when}`;
}

export interface ChatSettingsHeader {
  /** What the sheet's title says: "Task · <title>" for a task chat, else the chat's title. */
  readonly title: string;
  /** The meta line, parts joined with " · ". */
  readonly meta: string;
  /** The state dot drawn before the meta: none for a calm chat. */
  readonly dot: ChatChipState | null;
  readonly pinned: boolean;
  readonly preview: string | null;
}

export function chatSettingsHeader(target: ChatSettingsTarget, nowMs: number): ChatSettingsHeader {
  const title = target.kind === "task" ? `Task · ${target.title}` : target.title;
  const parts: string[] = [];
  let dot: ChatChipState | null = null;
  if (target.snoozedUntilMs !== null) {
    parts.push(`Snoozed until ${whenWords(target.snoozedUntilMs, nowMs)}`);
  } else if (target.archived) {
    parts.push("Archived", ...(target.isOpenChat ? ["This chat"] : []));
  } else {
    if (target.state !== "idle") dot = target.state;
    if (target.isOpenChat && target.kind === "task") {
      parts.push("Task chat", "This chat");
      if (target.words !== null) parts.push(capitalised(target.words));
    } else if (target.isOpenChat) {
      if (target.pinned) parts.push("Pinned");
      parts.push("This chat");
      parts.push(
        target.words !== null ? capitalised(target.words) : shortWhen(target.activityMs, nowMs),
      );
    } else if (target.words !== null) {
      parts.push(capitalised(target.words), shortWhen(target.activityMs, nowMs));
    } else {
      parts.push(lastMessageWords(target.activityMs, nowMs));
    }
  }
  return { title, meta: parts.join(" · "), dot, pinned: target.pinned, preview: target.preview };
}

export interface ChatSettingsRow {
  readonly id: ChatSettingsRowId;
  readonly label: string;
  /** Right-aligned words: the wake time, "Opens it", or why the row is disabled. */
  readonly detail: string | null;
  /** Greyed with its reason in `detail`; it stays in place. */
  readonly disabled: boolean;
  readonly destructive: boolean;
}

export interface ChatSettingsRowContext {
  /** The bot cannot take a turn right now (offline, provider unavailable). */
  readonly turnsUnavailable: boolean;
  /** A wrapup is already being sent from this screen. */
  readonly wrapupSending: boolean;
  /** The open chat's thread has not loaded yet (Rename and Wrapup wait for it). */
  readonly threadLoading: boolean;
  /** For the wake row's time. */
  readonly nowMs: number;
}

function row(
  id: ChatSettingsRowId,
  label: string,
  extra: Partial<Pick<ChatSettingsRow, "detail" | "disabled" | "destructive">> = {},
): ChatSettingsRow {
  return {
    id,
    label,
    detail: extra.detail ?? null,
    disabled: extra.disabled ?? false,
    destructive: extra.destructive ?? false,
  };
}

function wrapupRow(target: ChatSettingsTarget, context: ChatSettingsRowContext): ChatSettingsRow {
  if (context.turnsUnavailable)
    return row("wrapup", "Wrapup chat", { disabled: true, detail: "Unavailable" });
  if (target.working || context.wrapupSending) {
    return row("wrapup", "Wrapup chat", { disabled: true, detail: "After this reply" });
  }
  if (target.isOpenChat && context.threadLoading) {
    return row("wrapup", "Wrapup chat", { disabled: true, detail: "Loading" });
  }
  return row("wrapup", "Wrapup chat", { detail: target.isOpenChat ? null : "Opens it" });
}

/**
 * The sheet's rows in their three groups: state (Pin, Snooze or Wake, Mark
 * unread), edit (Rename, Wrapup) and end (Archive or Unarchive, Delete). Rows
 * that do not apply are left out, never greyed without a reason; an archived
 * chat has Rename, Unarchive and Delete only, as the menu always had.
 */
export function chatSettingsRows(
  target: ChatSettingsTarget,
  context: ChatSettingsRowContext,
): ReadonlyArray<ReadonlyArray<ChatSettingsRow>> {
  const state: ChatSettingsRow[] = [];
  if (!target.archived) {
    state.push(row(target.pinned ? "unpin" : "pin", target.pinned ? "Unpin chat" : "Pin chat"));
    if (target.snoozedUntilMs !== null) {
      state.push(
        row("wake", "Wake now", {
          detail: capitalised(whenWords(target.snoozedUntilMs, context.nowMs)),
        }),
      );
    } else {
      state.push(row("snooze", "Snooze…"));
    }
    if (!target.unread) state.push(row("markUnread", "Mark unread"));
  }
  const edit: ChatSettingsRow[] = [
    row("rename", "Rename chat", { disabled: target.isOpenChat && context.threadLoading }),
  ];
  if (!target.archived) edit.push(wrapupRow(target, context));
  const end: ChatSettingsRow[] = [
    target.archived ? row("unarchive", "Unarchive chat") : row("archive", "Archive chat"),
    row("delete", "Delete chat", { destructive: true }),
  ];
  return [state, edit, end].filter((group) => group.length > 0);
}

/** What a screen reader hears after a chip's (or the header's) name: the gesture has no visible control. */
export const CHAT_SETTINGS_HINT = "Touch and hold for chat settings.";

/** What the three-dots menu's "Chat settings…" row hints at. */
export function chatSettingsHint(chipsShown: boolean): string {
  return chipsShown ? "or hold a chip" : "or hold the name";
}

const open = "“";
const close = "”";

/** The chat's name in the sentences that name it: “Tennis”. */
export function quotedChatName(title: string): string {
  return `${open}${title}${close}`;
}

/**
 * What a failed action on another chat says, naming the chat: with the server's
 * own reason when it gave one, else "Try again."
 */
export function chatActionFailure(
  action: "archive" | "delete" | "rename",
  title: string,
  reason?: string,
): string {
  const lead = `Couldn't ${action} ${quotedChatName(title)}`;
  return reason === undefined ? `${lead}. Try again.` : `${lead}: ${reason}`;
}

/** The polite announcement after an action on another chat succeeded. */
export function chatActionAnnouncement(
  action: "pin" | "unpin" | "snooze" | "markUnread" | "archive" | "delete" | "rename" | "wake",
  title: string,
  detail?: string,
): string {
  const name = title;
  switch (action) {
    case "pin":
      return `${name} pinned.`;
    case "unpin":
      return `${name} unpinned.`;
    case "snooze":
      return `${name} snoozed${detail === undefined ? "" : ` until ${detail}`}.`;
    case "wake":
      return `${name} woken.`;
    case "markUnread":
      return `${name} marked unread.`;
    case "archive":
      return `${name} archived.`;
    case "delete":
      return `${name} deleted.`;
    case "rename":
      return `${name} renamed${detail === undefined ? "" : ` to ${quotedChatName(detail)}`}.`;
  }
}
