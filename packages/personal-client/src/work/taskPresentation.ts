import type { PersonalTask } from "@t3tools/contracts";

/** Names the app gives a chat before anything names it; they say nothing about the work. */
const PLACEHOLDER_CHAT_TITLES: ReadonlySet<string> = new Set(["New chat", "New thread"]);

/**
 * The title every list shows for a task. A request the owner made in a chat is
 * stored with the message as its title, which can be a raw tool string; the
 * chat's name says what the work is about. Every other task keeps its title.
 */
export function taskDisplayTitle(
  task: Pick<PersonalTask, "source" | "parentTaskId" | "threadId" | "title">,
  chatTitles: ReadonlyMap<string, string>,
): string {
  if (task.source !== "user" || task.parentTaskId !== null || task.threadId === null) {
    return task.title;
  }
  const chat = chatTitles.get(task.threadId)?.trim() ?? "";
  return chat.length === 0 || PLACEHOLDER_CHAT_TITLES.has(chat) ? task.title : chat;
}
