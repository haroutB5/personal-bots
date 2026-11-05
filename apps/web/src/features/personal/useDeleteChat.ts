import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  chatActionFailure,
  deleteChatConfirmMessage,
  type DeleteChatOptions,
} from "@hbots/personal-client/bots/chatActionText";
import { dropChatFromSnapshot } from "./chatsSnapshot";
import { commandFailureMessage, type DestructiveOutcome } from "./commandFeedback";
import { personalBotDeleteThread } from "./usePersonalBots";

export { deleteChatConfirmMessage, type DeleteChatOptions };

/**
 * Asks, then permanently deletes exactly one chat (the thread plus its
 * bot-thread link row). Bot-level data — memories, routines, secrets — is
 * untouched. A refusal comes back as `failed` with the server's message so the
 * caller can say so; the dialog has already closed by then either way.
 */
export function useDeleteChat(
  environmentId: EnvironmentId | null,
): (threadId: ThreadId, options?: DeleteChatOptions) => Promise<DestructiveOutcome> {
  const deleteThread = useAtomCommand(personalBotDeleteThread);
  return async (threadId, options) => {
    if (environmentId === null) {
      return { status: "failed", message: "Not connected to your computer." };
    }
    const message = deleteChatConfirmMessage(options);
    const confirmed =
      (await requestConfirmDialog(message, {
        variant: "destructive",
        confirmLabel: "Delete chat",
      })) ?? window.confirm(message);
    if (!confirmed) return { status: "cancelled" };
    const result = await deleteThread({ environmentId, input: { threadId } });
    const name = options?.title ?? options?.name;
    // An empty fallback tells "the server gave a reason" from "it gave none".
    const reason = commandFailureMessage(result, "");
    if (reason !== null) {
      return {
        status: "failed",
        message:
          name === undefined
            ? reason === ""
              ? "Couldn't delete this chat. Try again."
              : reason
            : chatActionFailure("delete", name, reason === "" ? undefined : reason),
      };
    }
    // The cold-start snapshot is only rewritten by the Chats screen, which is
    // not mounted here; without this the deleted chat keeps painting (name,
    // timestamp, deep link) on every offline launch until that screen runs.
    dropChatFromSnapshot(environmentId, (row) => row.threadId === threadId);
    return { status: "done" };
  };
}
