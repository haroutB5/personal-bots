import { chatNameTakenMessage, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import {
  RENAME_CHAT_MAX_CHARS,
  renameChatDraftTitle,
  renameChatInitialTitle,
} from "@hbots/personal-client/feed/renameChat";

import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { isChatNameTakenFailure } from "./chatNames";
import { commandFailureMessage } from "./commandFeedback";

export { RENAME_CHAT_MAX_CHARS, renameChatDraftTitle, renameChatInitialTitle };

/**
 * Renames one chat through the thread metadata command. A metadata rename is
 * the user's own title, so the AI title never overwrites it afterwards. Every
 * place that shows the title reads the thread shell, which the server's event
 * updates, so nothing here patches local state. Resolves to the server's
 * message when it refuses, null once the title is saved. A bot's open chats
 * have unique names: the server refuses a taken one with the `chat_name_taken`
 * code, which reads `A chat called "X" already exists`.
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
      if (isChatNameTakenFailure(result)) return chatNameTakenMessage(title);
      return commandFailureMessage(result, "Couldn't rename this chat. Try again.");
    } catch {
      return "Couldn't rename this chat. Try again.";
    }
  };
}
