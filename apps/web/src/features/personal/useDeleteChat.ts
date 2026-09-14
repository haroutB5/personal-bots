import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { dropChatFromSnapshot } from "./chatsSnapshot";
import { commandFailureMessage, type DestructiveOutcome } from "./commandFeedback";
import { personalBotDeleteThread } from "./usePersonalBots";

/** Confirm copy, kept pure so the permanent-deletion wording is unit-tested. */
export function deleteChatConfirmMessage(): string {
  return "Delete this chat permanently?\nThe whole conversation is removed and can't be undone.";
}

/**
 * Asks, then permanently deletes exactly one chat (the thread plus its
 * bot-thread link row). Bot-level data — memories, routines, secrets — is
 * untouched. A refusal comes back as `failed` with the server's message so the
 * caller can say so; the dialog has already closed by then either way.
 */
export function useDeleteChat(
  environmentId: EnvironmentId | null,
): (threadId: ThreadId) => Promise<DestructiveOutcome> {
  const deleteThread = useAtomCommand(personalBotDeleteThread);
  return async (threadId) => {
    if (environmentId === null) {
      return { status: "failed", message: "Not connected to your computer." };
    }
    const message = deleteChatConfirmMessage();
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return { status: "cancelled" };
    const result = await deleteThread({ environmentId, input: { threadId } });
    const failure = commandFailureMessage(result, "Couldn't delete this chat. Try again.");
    if (failure !== null) return { status: "failed", message: failure };
    // The cold-start snapshot is only rewritten by the Chats screen, which is
    // not mounted here; without this the deleted chat keeps painting (name,
    // timestamp, deep link) on every offline launch until that screen runs.
    dropChatFromSnapshot(environmentId, (row) => row.threadId === threadId);
    return { status: "done" };
  };
}
