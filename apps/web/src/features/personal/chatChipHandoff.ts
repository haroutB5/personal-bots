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
