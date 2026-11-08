import type { EnvironmentId, PersonalBotThread } from "@t3tools/contracts";
import type { JSX } from "react";

import { useLazyThreadShells } from "~/state/lazyThreadShells";

import { botThreadRows, chatCountsLabel } from "./botThreadRows";
import { useBotShells } from "./useBotShells";
import { usePersonalGroupRelayThreadIds } from "./usePersonalGroups";

/**
 * "8 open · 1 archived" beside "All chats", counted like the rows of the bot's
 * chat list. Rendered inside the menu popup, so the thread shells are only
 * watched while the menu is open; the bots list refreshes after every
 * archive and delete, which keeps the numbers current.
 */
export function AllChatsCount({
  environmentId,
  botId,
  links,
  archivedCount,
}: {
  environmentId: EnvironmentId;
  botId: string;
  links: ReadonlyArray<PersonalBotThread>;
  archivedCount?: number | undefined;
}): JSX.Element {
  useLazyThreadShells(environmentId, { botId });
  const shells = useBotShells(environmentId);
  const relayThreadIds = usePersonalGroupRelayThreadIds(environmentId);
  const rows = botThreadRows(botId, links, shells, relayThreadIds);
  const counts = { open: rows.active.length, archived: archivedCount ?? rows.archived.length };
  return (
    <span className="ml-auto pl-4 text-[13px] text-[var(--personal-text-tertiary)] tabular-nums">
      {chatCountsLabel(counts)}
    </span>
  );
}
