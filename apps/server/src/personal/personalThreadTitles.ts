import { MessageId } from "@t3tools/contracts";

import { DEFAULT_THREAD_TITLE } from "../orchestration/threadTitles.ts";

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

/**
 * An instruction a delegator or team lead sent into a running task
 * (`steer_task`). It carries the task prefix, so it never counts as the owner
 * speaking; `steerId` has no dashes, so it never parses as an attempt's id.
 */
export const personalTaskSteerMessageId = (steerId: string) =>
  MessageId.make(`${PERSONAL_TASK_MESSAGE_ID_PREFIX}steer-${steerId}`);

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

/**
 * Command tag of the write that makes a user-started bot chat's first message
 * its title (ProviderCommandReactor.personalFirstTurnTitleThread). The title's
 * version is `server:<tag>:<uuid>` while the chat still carries that seed.
 */
export const PERSONAL_TITLE_SEED_COMMAND_TAG = "personal-thread-title-seed";

const isPersonalTitleSeedVersion = (version: string) =>
  version.startsWith(`server:${PERSONAL_TITLE_SEED_COMMAND_TAG}:`);

/** Longest title a task or routine chat is created with. */
export const PERSONAL_TASK_THREAD_TITLE_MAX_LENGTH = 80;

/**
 * The title a chat newly created for a task or routine run starts with: the
 * task's title on one line, cut at a word near the limit, or the placeholder
 * when the task has no usable title.
 */
export const personalTaskThreadTitle = (taskTitle: string): string => {
  const title = taskTitle.replace(/\s+/g, " ").trim();
  if (title.length === 0) return PERSONAL_THREAD_TITLE;
  if (title.length <= PERSONAL_TASK_THREAD_TITLE_MAX_LENGTH) return title;
  const cut = title.slice(0, PERSONAL_TASK_THREAD_TITLE_MAX_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  const head = space >= PERSONAL_TASK_THREAD_TITLE_MAX_LENGTH / 2 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s.,;:!?-]+$/, "")}…`;
};

/**
 * Whether a title a provider reports for its own session (OpenCode's
 * `session.updated`, mirrored as `thread.metadata.updated`) may rename a
 * personal bot thread. The same rules as our first-turn title:
 * - a manual rename always wins;
 * - task, routine and group chats keep their names (any user message written
 *   by a task or a group round marks the chat as one);
 * - a chat the user started may lose its placeholder or first-message seed
 *   once, on its first turn only. Once any other title lands (ours or the
 *   provider's) the version is no longer the seed, so nothing renames it again.
 */
export const personalProviderTitleAllowed = (input: {
  readonly title: string;
  readonly titleState:
    | { readonly source: "manual" | "generated"; readonly version: string }
    | null
    | undefined;
  readonly userMessageIds: ReadonlyArray<string>;
}): boolean => {
  if (input.titleState?.source === "manual") return false;
  if (
    input.userMessageIds.some(
      (messageId) => isPersonalTaskMessageId(messageId) || isPersonalGroupMessageId(messageId),
    )
  ) {
    return false;
  }
  if (input.userMessageIds.length !== 1) return false;
  const title = input.title.trim();
  if (title === PERSONAL_THREAD_TITLE || title === DEFAULT_THREAD_TITLE) return true;
  return (
    input.titleState?.source === "generated" && isPersonalTitleSeedVersion(input.titleState.version)
  );
};
