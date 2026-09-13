import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { personalBotDeleteThread } from "./usePersonalBots";

/** Confirm copy, kept pure so the permanent-deletion wording is unit-tested. */
export function deleteChatConfirmMessage(): string {
  return "Delete this chat permanently?\nThe whole conversation is removed and can't be undone.";
}

/**
 * Asks, then permanently deletes exactly one chat (the thread plus its
 * bot-thread link row). Bot-level data — memories, routines, secrets — is
 * untouched. Resolves true once deleted.
 */
export function useDeleteChat(
  environmentId: EnvironmentId | null,
): (threadId: ThreadId) => Promise<boolean> {
  const deleteThread = useAtomCommand(personalBotDeleteThread);
  return async (threadId) => {
    if (environmentId === null) return false;
    const message = deleteChatConfirmMessage();
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return false;
    const result = await deleteThread({ environmentId, input: { threadId } });
    return result._tag === "Success";
  };
}
