import { useEffect, useRef } from "react";

import type { PersonalBotThread, PersonalTask } from "@t3tools/contracts";

/**
 * The bots list (bot to chat links) is a query, but the server also creates
 * chats on its own: delegated tasks and routine runs. The live task feed names
 * those chats, so refetch the list once whenever it mentions a chat the list
 * does not know yet. Without this a delegated bot looks chat-less and tapping
 * it starts an empty chat instead of opening the delegated one.
 */
export function useRefreshBotsForTaskThreads(input: {
  readonly links: ReadonlyArray<PersonalBotThread> | null;
  readonly tasks: ReadonlyArray<PersonalTask>;
  readonly refresh: () => void;
}): void {
  const { links, tasks, refresh } = input;
  const unknownKey = (() => {
    if (links === null) return null;
    const known = new Set<string>(links.map((link) => link.threadId));
    const unknown = tasks
      .flatMap((task) => (task.threadId === null ? [] : [task.threadId as string]))
      .filter((threadId) => !known.has(threadId))
      .toSorted();
    return unknown.length === 0 ? null : unknown.join(",");
  })();
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (unknownKey === null || lastKey.current === unknownKey) return;
    lastKey.current = unknownKey;
    refresh();
  }, [refresh, unknownKey]);
}
