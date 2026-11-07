import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_BOT_THREADS_BATCH_MAX } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";

import type { NativePersonal } from "./nativePersonalClient";

const SHELL_REFRESH_MS = 5_000;

export interface BotShells {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly status: "empty" | "synchronizing" | "live";
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * The bot chats a screen paints, read through the personal contract rather
 * than the v1 shell stream. The stream carries every thread on the machine,
 * including ones no bot owns; personalBots.threadShells carries only the
 * linked chats and the v1 fields their rows read.
 */
export function useBotShells(native: NativePersonal, environmentId: EnvironmentId): BotShells {
  const list = native.bots.usePersonalBotsList(environmentId);
  const connection = native.useConnectionState();
  const idsKey =
    list.data === null
      ? ""
      : list.data.threads
          .map((link) => link.threadId as string)
          .toSorted()
          .slice(0, PERSONAL_BOT_THREADS_BATCH_MAX)
          .join(",");
  const atom = useMemo(
    () =>
      idsKey.length === 0
        ? null
        : native.bots.personalBotsThreadShells({
            environmentId,
            input: { threadIds: idsKey.split(",") as ThreadId[] },
          }),
    [environmentId, idsKey, native],
  );
  const query = native.client.useEnvironmentQuery(atom);
  const refresh = query.refresh;
  const refreshList = list.refresh;

  useEffect(() => {
    if (atom === null || connection.phase !== "connected") return;
    const timer = setInterval(() => {
      refresh();
      refreshList();
    }, SHELL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [atom, connection.phase, refresh, refreshList]);

  const shells = useMemo<ReadonlyArray<EnvironmentThreadShell>>(
    () =>
      query.data === null ? [] : query.data.threads.map((thread) => ({ ...thread, environmentId })),
    [environmentId, query.data],
  );

  return {
    shells,
    status: connection.phase !== "connected" ? "empty" : query.isSuccess ? "live" : "synchronizing",
    error: query.error,
    refresh,
  };
}
