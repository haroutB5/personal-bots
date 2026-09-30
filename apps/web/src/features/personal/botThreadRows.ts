import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { chatActivityMs } from "./chatActivity";

export interface BotThreadRow {
  readonly link: PersonalBotThread;
  readonly shell: EnvironmentThreadShell;
  readonly updatedMs: number;
}

/**
 * A bot's chats split into open and archived, newest first: the rows of
 * /bots/$botId. `relayThreadIds` (groupRelayThreadIds) are the bot's private
 * relays of its groups: they belong to the group screen, never to this list.
 */
export function botThreadRows(
  botId: string,
  links: ReadonlyArray<PersonalBotThread>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
  relayThreadIds: ReadonlySet<string> = new Set(),
): { active: BotThreadRow[]; archived: BotThreadRow[] } {
  const shellsById = new Map(shells.map((shell) => [shell.id as string, shell] as const));
  const rows = links.flatMap((link): BotThreadRow[] => {
    if (link.botId !== botId || relayThreadIds.has(link.threadId)) return [];
    const shell = shellsById.get(link.threadId);
    if (shell === undefined) return [];
    // Real conversation activity, never `updatedAt` (see chatActivity.ts).
    return [{ link, shell, updatedMs: chatActivityMs(shell, link) }];
  });
  const newestFirst = (left: BotThreadRow, right: BotThreadRow) => right.updatedMs - left.updatedMs;
  return {
    active: rows
      .filter((row) => row.link.archivedAt === null && row.shell.archivedAt === null)
      .toSorted(newestFirst),
    archived: rows.filter((row) => row.link.archivedAt !== null).toSorted(newestFirst),
  };
}

/** The muted count beside "All chats": "8 open · 1 archived", archived only when there are some. */
export function chatCountsLabel(counts: { readonly open: number; readonly archived: number }) {
  const open = `${counts.open} open`;
  return counts.archived > 0 ? `${open} · ${counts.archived} archived` : open;
}
