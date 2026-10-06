import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { chatActivityMs } from "./chatActivity";
import { isChatPinned, snoozeEndMs, soonestWakeFirst, pinnedFirst } from "./chatState";
import { isGroupRelayLink } from "./groupModel";

export interface BotThreadRow {
  readonly link: PersonalBotThread;
  readonly shell: EnvironmentThreadShell;
  readonly updatedMs: number;
}

/**
 * A bot's chats split into open, snoozed and archived: the rows of
 * /bots/$botId. Open is pinned chats first, then the rest, each newest first.
 * Snoozed (still asleep at `nowMs`) leave the open list and wait in their own
 * section, soonest wake first. `relayThreadIds` (groupRelayThreadIds) are the
 * bot's private relays of its groups: they belong to the group screen, never
 * to this list.
 */
export function botThreadRows(
  botId: string,
  links: ReadonlyArray<PersonalBotThread>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
  relayThreadIds: ReadonlySet<string> = new Set(),
  nowMs: number = Date.now(),
): { active: BotThreadRow[]; archived: BotThreadRow[]; snoozed: BotThreadRow[] } {
  const shellsById = new Map(shells.map((shell) => [shell.id as string, shell] as const));
  const rows = links.flatMap((link): BotThreadRow[] => {
    if (link.botId !== botId || isGroupRelayLink(link, relayThreadIds)) return [];
    const shell = shellsById.get(link.threadId);
    if (shell === undefined) return [];
    // Real conversation activity, never `updatedAt` (see chatActivity.ts).
    return [{ link, shell, updatedMs: chatActivityMs(shell, link) }];
  });
  const newestFirst = (left: BotThreadRow, right: BotThreadRow) => right.updatedMs - left.updatedMs;
  const open = rows.filter((row) => row.link.archivedAt === null && row.shell.archivedAt === null);
  const asleep = (row: BotThreadRow) => snoozeEndMs(row.link, nowMs) !== null;
  return {
    active: pinnedFirst(open.filter((row) => !asleep(row)).toSorted(newestFirst), (row) =>
      isChatPinned(row.link),
    ),
    archived: rows.filter((row) => row.link.archivedAt !== null).toSorted(newestFirst),
    snoozed: soonestWakeFirst(open.filter(asleep), (row) => snoozeEndMs(row.link, nowMs) ?? 0),
  };
}

/** The muted count beside "All chats": "8 open · 1 archived", archived only when there are some. */
export function chatCountsLabel(counts: { readonly open: number; readonly archived: number }) {
  const open = `${counts.open} open`;
  return counts.archived > 0 ? `${open} · ${counts.archived} archived` : open;
}
