import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { requestConfirmDialog } from "~/confirmDialog";
import { useAtomCommand } from "~/state/use-atom-command";

import { dropChatFromSnapshot } from "./chatsSnapshot";
import { commandFailureMessage, type DestructiveOutcome } from "./commandFeedback";
import { personalBotDeleteThread } from "./usePersonalBots";

export interface DeleteChatOptions {
  /** Another chat than the open one: the confirm names it. */
  readonly title?: string | undefined;
  /** A turn is running in the chat: the confirm says deleting stops it too. */
  readonly working?: boolean | undefined;
}

/** Confirm copy, kept pure so the permanent-deletion wording is unit-tested. */
export function deleteChatConfirmMessage(options: DeleteChatOptions = {}): string {
  const subject = options.title === undefined ? "this chat" : `“${options.title}”`;
  const lines = [
    `Delete ${subject} permanently?`,
    "The whole conversation is removed and can't be undone.",
  ];
  if (options.working === true) {
    lines.push("It is working right now; deleting it stops that too.");
  }
  return lines.join("\n");
}

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
    const failure = commandFailureMessage(
      result,
      options?.title === undefined
        ? "Couldn't delete this chat. Try again."
        : `Couldn't delete “${options.title}”. Try again.`,
    );
    if (failure !== null) return { status: "failed", message: failure };
    // The cold-start snapshot is only rewritten by the Chats screen, which is
    // not mounted here; without this the deleted chat keeps painting (name,
    // timestamp, deep link) on every offline launch until that screen runs.
    dropChatFromSnapshot(environmentId, (row) => row.threadId === threadId);
    return { status: "done" };
  };
}
