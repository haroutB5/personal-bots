import { conversationChatTitle } from "./chatNames.ts";

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
