import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { conversationChatTitle } from "./ConversationHeaderName";

/**
 * Longest title the rename field takes. The contract has no cap of its own;
 * 80 matches the server's own titles for tasks, and still fits a list row.
 */
export const RENAME_CHAT_MAX_CHARS = 80;

/** What the field starts with: the chat's title, or empty for an untitled "New chat". */
export function renameChatInitialTitle(title: string | null | undefined): string {
  return conversationChatTitle(title) ?? "";
}

/** The title Save would send, or null while Save has nothing to do (empty or unchanged). */
export function renameChatDraftTitle(draft: string, initial: string): string | null {
  const title = draft.trim().slice(0, RENAME_CHAT_MAX_CHARS);
  if (title.length === 0 || title === initial.trim()) return null;
  return title;
}

/**
 * Renames one chat through the thread metadata command. A metadata rename is
 * the user's own title, so the AI title never overwrites it afterwards. Every
 * place that shows the title reads the thread shell, which the server's event
 * updates, so nothing here patches local state. Resolves to the server's
 * message when it refuses, null once the title is saved.
 */
export function useRenameChat(
  environmentId: EnvironmentId | null,
): (threadId: ThreadId, title: string) => Promise<string | null> {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  return async (threadId, title) => {
    if (environmentId === null) return "Not connected to your computer.";
    try {
      const result = await updateMetadata({ environmentId, input: { threadId, title } });
      return commandFailureMessage(result, "Couldn't rename this chat. Try again.");
    } catch {
      return "Couldn't rename this chat. Try again.";
    }
  };
}
