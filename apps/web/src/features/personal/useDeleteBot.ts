import type { EnvironmentId, PersonalBot } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { dropChatFromSnapshot } from "./chatsSnapshot";
import { commandFailureMessage, type DestructiveOutcome } from "./commandFeedback";
import { personalBotDelete } from "./usePersonalBots";

/**
 * Asks, then deletes a bot completely (its chats, routines, running tasks and
 * bot-only memories and secrets go with it). A refusal comes back as `failed`
 * with the server's message so the caller can say so.
 */
export function useDeleteBot(
  environmentId: EnvironmentId | null,
): (bot: Pick<PersonalBot, "botId" | "name">) => Promise<DestructiveOutcome> {
  const deleteBot = useAtomCommand(personalBotDelete);
  return async (bot) => {
    if (environmentId === null) {
      return { status: "failed", message: "Not connected to your computer." };
    }
    const message = `Delete ${bot.name} completely?\nIts chats, routines and memories are removed too. This can't be undone.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return { status: "cancelled" };
    const result = await deleteBot({ environmentId, input: { botId: bot.botId } });
    const failure = commandFailureMessage(result, `Couldn't delete ${bot.name}. Try again.`);
    if (failure !== null) return { status: "failed", message: failure };
    // Same reason as `useDeleteChat`: the Chats screen owns the only snapshot
    // write, and deletion can happen with that screen unmounted.
    dropChatFromSnapshot(environmentId, (row) => row.botId === bot.botId);
    return { status: "done" };
  };
}
