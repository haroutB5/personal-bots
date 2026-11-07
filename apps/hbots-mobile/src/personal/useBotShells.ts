import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";

import type { EnvironmentThreadShell } from "@hbots/personal-client/bots/threadShell";

import type { NativePersonal } from "./nativePersonalClient";

export interface BotShells {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly status: "empty" | "synchronizing" | "live";
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * Bot chats from the one shared shells store: snapshot, then upserts and
 * removals. No interval. A shell missing from `personalBots.list` refreshes
 * the list once; foreground refreshes it too.
 */
export function useBotShells(native: NativePersonal, environmentId: EnvironmentId): BotShells {
  const store = native.bots.usePersonalBotShells(environmentId);
  const list = native.bots.usePersonalBotsList(environmentId);
  const connection = native.useConnectionState();

  const shells = useMemo<ReadonlyArray<EnvironmentThreadShell>>(
    () =>
      store.data === null
        ? []
        : [...store.data.values()].map((thread) => ({ ...thread, environmentId })),
    [environmentId, store.data],
  );

  const refreshList = list.refresh;
  const knownIds = useMemo(
    () => new Set((list.data?.threads ?? []).map((link) => link.threadId as string)),
    [list.data],
  );
  const unknownIds = useMemo(
    () =>
      store.data === null || list.data === null
        ? ""
        : [...store.data.keys()]
            .filter((threadId) => !knownIds.has(threadId))
            .toSorted()
            .join(","),
    [knownIds, list.data, store.data],
  );
  const refreshedUnknownIds = useRef("");
  useEffect(() => {
    if (unknownIds.length === 0 || refreshedUnknownIds.current === unknownIds) return;
    refreshedUnknownIds.current = unknownIds;
    refreshList();
  }, [refreshList, unknownIds]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshList();
    });
    return () => subscription.remove();
  }, [refreshList]);

  return {
    shells,
    status: connection.phase !== "connected" ? "empty" : store.isSuccess ? "live" : "synchronizing",
    error: store.error,
    refresh: store.refresh,
  };
}
