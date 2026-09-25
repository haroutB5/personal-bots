import { useEffect, useRef } from "react";

import {
  PERSONAL_TASK_TERMINAL_STATUSES,
  type PersonalBot,
  type PersonalBotThread,
  type PersonalTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** A task can name its chat a moment before the server links it to the bot. */
const RETRY_AFTER_MS = 3_000;
/**
 * A task that finished longer ago than this and still names a chat the list
 * does not have will not get one (its chat was deleted): refetching for it
 * cost two list requests on every app open.
 */
export const SETTLED_TASK_MS = 10 * 60_000;

/**
 * The chats the task feed names that the list does not know yet, as a key
 * (thread@updatedAt, sorted), or null when there are none worth a refetch.
 */
export function unknownTaskThreadsKey(input: {
  readonly bots: ReadonlyArray<PersonalBot> | null;
  readonly links: ReadonlyArray<PersonalBotThread> | null;
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly now: number;
}): string | null {
  const { bots, links, tasks, now } = input;
  if (bots === null || links === null) return null;
  const liveBots = new Set<string>(bots.map((bot) => bot.botId));
  const known = new Set<string>(links.map((link) => link.threadId));
  const unknown = tasks
    .filter(
      (task) =>
        task.threadId !== null &&
        liveBots.has(task.botId) &&
        !known.has(task.threadId) &&
        !(
          PERSONAL_TASK_TERMINAL_STATUSES.includes(task.status) &&
          now - DateTime.toEpochMillis(task.updatedAt) > SETTLED_TASK_MS
        ),
    )
    .map((task) => `${task.threadId}@${task.updatedAt}`)
    .toSorted();
  return unknown.length === 0 ? null : unknown.join(",");
}

/**
 * The bots list (bot to chat links) is a query, but the server also creates
 * chats on its own: delegated tasks and routine runs. The live task feed names
 * those chats, so refetch the list whenever it names a chat of a live bot the
 * list does not know yet, again on each later update of that task, and once
 * more shortly after in case the link was still being written. Without this a
 * delegated bot looks chat-less and tapping it starts an empty chat.
 */
export function useRefreshBotsForTaskThreads(input: {
  readonly bots: ReadonlyArray<PersonalBot> | null;
  readonly links: ReadonlyArray<PersonalBotThread> | null;
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly refresh: () => void;
}): void {
  const { bots, links, tasks, refresh } = input;
  const unknownKey = unknownTaskThreadsKey({ bots, links, tasks, now: Date.now() });
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (unknownKey === null || lastKey.current === unknownKey) return;
    lastKey.current = unknownKey;
    refresh();
    const retry = window.setTimeout(refresh, RETRY_AFTER_MS);
    return () => window.clearTimeout(retry);
  }, [refresh, unknownKey]);
}
