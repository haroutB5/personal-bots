/**
 * Two small hand-offs from the chat chips to the screens around them.
 *
 * - A chip switch tells the next transcript to ease in (new messages fade up
 *   8 px over 180 ms). Only a switch does: opening a chat from a list is not
 *   animated. The mark expires, so a late mount never animates by accident.
 * - The header remembers, per bot, whether it showed the chips, so the
 *   header-only first frame of a chat (ConversationShellHeader) is already
 *   72 px tall and the screen below does not drop 8 px when the chat mounts.
 */

const SWITCH_WINDOW_MS = 3_000;

let switchedUntil = 0;

export function markChatSwitched(nowMs: number = Date.now()): void {
  switchedUntil = nowMs + SWITCH_WINDOW_MS;
}

/** Whether a transcript that mounts now follows a chip switch. Reads once: the mark is spent. */
export function consumeChatSwitched(nowMs: number = Date.now()): boolean {
  const switched = nowMs <= switchedUntil;
  switchedUntil = 0;
  return switched;
}

const chipsShownByBot = new Map<string, boolean>();

export function rememberChipsShown(botId: string, shown: boolean): void {
  chipsShownByBot.set(botId, shown);
}

export function chipsShownFor(botId: string): boolean {
  return chipsShownByBot.get(botId) ?? false;
}

/**
 * Wrapup on another chat from the chat settings sheet: it needs that chat's
 * thread loaded, so the sheet opens the chat and leaves this mark; the chat
 * that mounts sends the wrapup once its thread has loaded. The mark expires,
 * so a chat opened by hand later never starts one by accident.
 */
const PENDING_WRAPUP_WINDOW_MS = 10_000;

let pendingWrapup: { readonly threadId: string; readonly until: number } | null = null;

export function markPendingWrapup(threadId: string, nowMs: number = Date.now()): void {
  pendingWrapup = { threadId, until: nowMs + PENDING_WRAPUP_WINDOW_MS };
}

/** The chat a wrapup is waiting for, while the mark is alive. Does not spend it. */
export function pendingWrapupFor(threadId: string, nowMs: number = Date.now()): boolean {
  return (
    pendingWrapup !== null && pendingWrapup.threadId === threadId && nowMs <= pendingWrapup.until
  );
}

export function clearPendingWrapup(): void {
  pendingWrapup = null;
}

/** What the chat that mounted should do about a pending wrapup. */
export type PendingWrapupStep = "none" | "wait" | "start" | "fail";

/**
 * `wait`: the thread has not loaded yet. `start`: send it now. `fail`: the chat
 * cannot take a turn (a turn runs, the bot is unavailable, the chat is
 * archived), so the mark is spent and the usual error is shown.
 */
export function pendingWrapupStep(input: {
  readonly pending: boolean;
  readonly threadLoaded: boolean;
  readonly canStart: boolean;
}): PendingWrapupStep {
  if (!input.pending) return "none";
  if (!input.threadLoaded) return "wait";
  return input.canStart ? "start" : "fail";
}
