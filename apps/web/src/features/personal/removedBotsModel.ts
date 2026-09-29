import * as DateTime from "effect/DateTime";
import type { PersonalBotRestoreResult, PersonalRemovedBot } from "@t3tools/contracts";
import { DEFAULT_PERSONAL_BOT_TEAM, personalBotTeamLabel } from "@t3tools/contracts";

import { formatRelativeTime } from "./relativeTime";

/** "Assistant's team · Sonnet 5.5 · H": the muted second line of a removed bot. */
export function removedBotSubtitle(bot: Pick<PersonalRemovedBot, "team" | "modelLabel">): string {
  const team = personalBotTeamLabel(bot.team);
  return bot.modelLabel.trim().length === 0 ? team : `${team} · ${bot.modelLabel}`;
}

/** "Removed by CFO today" / "yesterday" / "on 12 Sep" (a year is added for older ones). */
export function removedByLine(
  bot: Pick<PersonalRemovedBot, "removedBy" | "removedAt">,
  nowMs: number,
): string {
  const relative = formatRelativeTime(DateTime.toEpochMillis(bot.removedAt), nowMs);
  const when =
    relative === "Yesterday"
      ? "yesterday"
      : /^(Now|\d+[mh])$/.test(relative)
        ? "today"
        : `on ${relative}`;
  return `Removed by ${bot.removedBy} ${when}`;
}

export function chatsKeptLabel(chats: number): string {
  return `${chats} ${chats === 1 ? "chat" : "chats"} kept`;
}

/** What the row says once the bot is back. */
export function restoredMessage(result: PersonalBotRestoreResult): string {
  const { bot, renamedFrom } = result;
  return renamedFrom !== null
    ? `Restored as ${bot.name} (the name ${renamedFrom} was taken)`
    : `${bot.name} restored to ${personalBotTeamLabel(bot.team ?? DEFAULT_PERSONAL_BOT_TEAM)}`;
}

/**
 * Every removed bot seen so far, in first-seen order. A restored bot drops out
 * of the server's list on the next refresh, but its row has to stay long
 * enough to say it worked, so the screen renders from this and not the list.
 */
export function mergeSeenRemovedBots(
  seen: ReadonlyArray<PersonalRemovedBot>,
  incoming: ReadonlyArray<PersonalRemovedBot>,
): ReadonlyArray<PersonalRemovedBot> {
  const known = new Set(seen.map((bot) => bot.botId));
  const added = incoming.filter((bot) => !known.has(bot.botId));
  return added.length === 0 ? seen : [...seen, ...added];
}
