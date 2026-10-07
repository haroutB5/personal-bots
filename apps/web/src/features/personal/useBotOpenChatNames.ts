import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadShells } from "~/state/entities";

import { botOpenChatNames } from "./chatNames";
import { usePersonalBotsList } from "./usePersonalBots";
import { usePersonalGroupRelayThreadIds } from "./usePersonalGroups";

/**
 * The names of a bot's open chats, from the lists the app already holds. What
 * the New chat and Rename fields compare a typed name with.
 */
export function useBotOpenChatNames(
  environmentId: EnvironmentId | null,
  botId: string | null,
): ReadonlyArray<{ readonly threadId: string; readonly title: string }> {
  const list = usePersonalBotsList(environmentId);
  const shells = useThreadShells();
  const relayThreadIds = usePersonalGroupRelayThreadIds(environmentId);
  const links = list.data?.threads ?? null;
  return useMemo(
    () =>
      botId === null || links === null
        ? []
        : botOpenChatNames(
            botId,
            links,
            shells.filter((shell) => shell.environmentId === environmentId),
            relayThreadIds,
          ),
    [botId, environmentId, links, relayThreadIds, shells],
  );
}
