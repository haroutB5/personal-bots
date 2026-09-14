import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { dropChatFromSnapshot } from "./chatsSnapshot";
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
    if (result._tag !== "Success") return false;
    // The cold-start snapshot is only rewritten by the Chats screen, which is
    // not mounted here; without this the deleted chat keeps painting (name,
    // timestamp, deep link) on every offline launch until that screen runs.
    dropChatFromSnapshot(environmentId, (row) => row.threadId === threadId);
    return true;
  };
}
