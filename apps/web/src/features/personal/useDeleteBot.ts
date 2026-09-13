import type { EnvironmentId, PersonalBot } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { personalBotDelete } from "./usePersonalBots";

/**
 * Asks, then deletes a bot completely (its chats, routines, running tasks and
 * bot-only memories and secrets go with it). Resolves true once deleted.
 */
export function useDeleteBot(
  environmentId: EnvironmentId | null,
): (bot: Pick<PersonalBot, "botId" | "name">) => Promise<boolean> {
  const deleteBot = useAtomCommand(personalBotDelete);
  return async (bot) => {
    if (environmentId === null) return false;
    const message = `Delete ${bot.name} completely?\nIts chats, routines and memories are removed too. This can't be undone.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return false;
    const result = await deleteBot({ environmentId, input: { botId: bot.botId } });
    return result._tag === "Success";
  };
}
