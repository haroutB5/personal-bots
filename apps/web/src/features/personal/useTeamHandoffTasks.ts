import { useEffect, useMemo, useRef, useState } from "react";

import type { EnvironmentId, PersonalTask } from "@t3tools/contracts";
import { useAtomCommand } from "~/state/use-atom-command";

import { historyReachesCutoff } from "./teamConstellationModel";
import { personalTaskHistory } from "./usePersonalAutomation";

/** Finished tasks asked for per page; the RPC allows up to 100. */
const PAGE_SIZE = 100;
/** At most this many pages (600 tasks): a week of handoffs is far below it. */
const MAX_PAGES = 6;

/**
 * The tasks the Team screen counts handoffs from: the live feed (every
 * unfinished task and only the newest 20 finished ones) plus finished tasks
 * paged in from `personalTasks.history` until the last 7 days are covered, so a
 * spoke's thickness is the week's real count and not the newest 20.
 */
export function useTeamHandoffTasks(
  environmentId: EnvironmentId | null,
  feed: ReadonlyArray<PersonalTask>,
  /** The live feed has arrived, so the connection is up: only then is history asked for. */
  feedReady: boolean,
): ReadonlyArray<PersonalTask> {
  const loadHistory = useAtomCommand(personalTaskHistory, {
    label: "personal-tasks:history",
    reportFailure: false,
  });
  const load = useRef(loadHistory);
  useEffect(() => {
    load.current = loadHistory;
  });
  const [older, setOlder] = useState<ReadonlyArray<PersonalTask>>([]);

  useEffect(() => {
    if (environmentId === null || !feedReady) return;
    let cancelled = false;
    void (async () => {
      const collected: PersonalTask[] = [];
      let before: PersonalTask["taskId"] | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const outcome = await load.current({
          environmentId,
          input: { limit: PAGE_SIZE, ...(before === undefined ? {} : { before }) },
        });
        if (cancelled || outcome._tag !== "Success") return;
        collected.push(...outcome.value.tasks);
        setOlder([...collected]);
        const last = outcome.value.tasks.at(-1);
        if (!outcome.value.hasMore || last === undefined) return;
        if (historyReachesCutoff(outcome.value.tasks, Date.now())) return;
        before = last.taskId;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, feedReady]);

  return useMemo(() => {
    if (older.length === 0) return feed;
    const byId = new Map<string, PersonalTask>(older.map((task) => [task.taskId as string, task]));
    // The feed is live, so it wins over a page loaded a moment ago.
    for (const task of feed) byId.set(task.taskId as string, task);
    return [...byId.values()];
  }, [feed, older]);
}
