import type { PersonalBot } from "@t3tools/contracts";

import type { PersonalBotGroupPresence } from "./PersonalBotRepository.ts";

/**
 * Stamps each bot with the groups it is in and whether it is group-only: in at
 * least one live group and with no private chat of its own (see
 * {@link PersonalBotGroupPresence} for what counts as one). A bot the presence
 * query did not return (a race with a create) is treated as in no group, so it
 * is shown rather than lost.
 */
export function withGroupPresence(
  bots: ReadonlyArray<PersonalBot>,
  presence: ReadonlyArray<PersonalBotGroupPresence>,
): PersonalBot[] {
  const byBot = new Map(presence.map((row) => [row.botId as string, row] as const));
  return bots.map((bot) => {
    const row = byBot.get(bot.botId);
    const groupIds = row === undefined ? [] : [...row.groupIds].toSorted();
    return {
      ...bot,
      groupIds,
      groupOnly: groupIds.length > 0 && row !== undefined && !row.hasPrivateChat,
    };
  });
}
