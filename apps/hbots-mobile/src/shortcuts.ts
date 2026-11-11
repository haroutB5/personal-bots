import { findCtoBot } from "./tile/ctoTarget";
import type { ShortcutEntry } from "./launcher/nativeLauncher";

/** Native keeps at most this many dynamic shortcuts. */
export const MAX_SHORTCUTS = 4;

interface ShortcutCandidate {
  readonly botId: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly pinned?: boolean;
  readonly team?: string;
  readonly lead?: boolean;
}

/**
 * The dynamic launcher shortcuts: the enabled pinned bots, in the list's order, at most four. The
 * CTO bot is left out because the static shortcut ("New CTO chat", built into the manifest) already
 * opens a new chat with it, and the launcher shows static ones first. Each opens a new chat with
 * the bot (`hbots://bot/<id>?new=1`, the same link the tile uses); native builds the link.
 */
export function buildShortcutFeed(
  bots: ReadonlyArray<ShortcutCandidate>,
): ReadonlyArray<ShortcutEntry> {
  const ctoId = findCtoBot(bots)?.botId;
  return bots
    .filter((bot) => bot.pinned === true && bot.enabled !== false && bot.botId !== ctoId)
    .slice(0, MAX_SHORTCUTS)
    .map((bot) => ({ botId: bot.botId, name: bot.name }));
}

export function shortcutFeedKey(feed: ReadonlyArray<ShortcutEntry>): string {
  return JSON.stringify(feed.map((bot) => [bot.botId, bot.name]));
}
