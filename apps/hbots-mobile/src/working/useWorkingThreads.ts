import { currentProgressNote } from "@hbots/personal-client/bots/workingProgress";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import type { NativePersonal } from "../personal/nativePersonalClient";
import { useBotShells } from "../personal/useBotShells";
import { workingThreads, type WorkingThread } from "./workingThreads";

export interface WorkingThreadsView {
  /** `loading` until the shells store and the bot list have both answered once. */
  readonly status: "loading" | "ready";
  readonly threads: ReadonlyArray<WorkingThread>;
  /** The current step per chat, only from the turn the chat reports as its latest. */
  readonly notes: ReadonlyMap<string, string>;
}

const NONE: ReadonlyMap<string, string> = new Map();

/**
 * Which chats are running now and what each is doing. It reads the same shared stores as the Bots
 * list (shells and `personalBots.workingProgress`), so it adds no new subscription.
 */
export function useWorkingThreads(native: NativePersonal): WorkingThreadsView {
  const environmentId = native.environmentId as EnvironmentId;
  const list = native.bots.usePersonalBotsList(environmentId);
  const botShells = useBotShells(native, environmentId);
  const ready = botShells.status === "live" && list.data !== null;

  const threads = useMemo(
    () =>
      list.data === null
        ? []
        : workingThreads({
            bots: list.data.bots,
            links: list.data.threads,
            shells: botShells.shells,
          }),
    [list.data, botShells.shells],
  );

  const progressKey = useMemo(() => {
    const updated = new Map(botShells.shells.map((shell) => [shell.id as string, shell.updatedAt]));
    return threads
      .map((thread) => `${thread.threadId}@${String(updated.get(thread.threadId))}`)
      .toSorted()
      .join("|");
  }, [threads, botShells.shells]);

  const progressAtom = useMemo(
    () =>
      progressKey.length === 0
        ? null
        : native.bots.personalBotsWorkingProgress({
            environmentId,
            input: {
              threadIds: progressKey
                .split("|")
                .map((entry) => entry.slice(0, entry.indexOf("@")) as ThreadId),
            },
          }),
    [environmentId, native, progressKey],
  );
  const progress = native.client.useEnvironmentQuery(progressAtom).data;

  const notes = useMemo(() => {
    if (progress === null || progress === undefined) return NONE;
    const shellById = new Map(botShells.shells.map((shell) => [shell.id as string, shell]));
    const found = new Map<string, string>();
    for (const entry of progress.notes) {
      const shell = shellById.get(entry.threadId as string);
      if (shell === undefined) continue;
      const note = currentProgressNote(
        { note: entry.note, turnId: entry.turnId, toolStep: entry.toolStep },
        shell,
      );
      if (note !== undefined) found.set(entry.threadId as string, note);
    }
    return found;
  }, [progress, botShells.shells]);

  return { status: ready ? "ready" : "loading", threads, notes };
}
