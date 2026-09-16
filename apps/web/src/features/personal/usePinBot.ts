import { isBotPinned, type EnvironmentId, type PersonalBot } from "@t3tools/contracts";

import { useAtomCommand } from "~/state/use-atom-command";

import { personalBotUpdate } from "./usePersonalBots";

/**
 * Pins or unpins a bot from the chats list. The update command refreshes
 * `personalBots.list` itself, so the pinned box re-renders from server state
 * rather than a local guess.
 */
export function useTogglePinBot(
  environmentId: EnvironmentId | null,
): (bot: PersonalBot) => Promise<void> {
  const updateBot = useAtomCommand(personalBotUpdate);
  return async (bot: PersonalBot) => {
    if (environmentId === null) return;
    await updateBot({
      environmentId,
      input: { botId: bot.botId, pinned: !isBotPinned(bot) },
    });
  };
}
