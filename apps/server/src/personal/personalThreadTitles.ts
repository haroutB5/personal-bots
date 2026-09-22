import { MessageId } from "@t3tools/contracts";

/** Title of a new bot thread until its first message names it. */
export const PERSONAL_THREAD_TITLE = "New chat";

const PERSONAL_TASK_MESSAGE_ID_PREFIX = "personal-task-";

/**
 * The user message that starts a task attempt's turn (tasks and routines).
 * Deterministic so a re-dispatch dedupes. The prefix also tells the title
 * generator that the user did not type this first message.
 */
export const personalTaskMessageId = (taskId: string, attempt: number) =>
  MessageId.make(`${PERSONAL_TASK_MESSAGE_ID_PREFIX}${taskId}-${attempt}`);

export const isPersonalTaskMessageId = (messageId: string) =>
  messageId.startsWith(PERSONAL_TASK_MESSAGE_ID_PREFIX);

/**
 * Every message a group round writes, including the brief that starts a
 * member's turn (`personal-group-<round>-brief-<n>`, see PersonalGroupService).
 * A turn started by one belongs to the round: it skips, re-queues or waits
 * out a provider fault itself, so nothing else may re-run it.
 */
export const isPersonalGroupMessageId = (messageId: string) =>
  messageId.startsWith("personal-group-");
