import type { PersonalBotThread } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export interface BotThreadRow {
  readonly link: PersonalBotThread;
  readonly shell: EnvironmentThreadShell;
  readonly updatedMs: number;
}

/** A bot's chats split into open and archived, newest first: the rows of /bots/$botId. */
export function botThreadRows(
  botId: string,
  links: ReadonlyArray<PersonalBotThread>,
  shells: ReadonlyArray<EnvironmentThreadShell>,
): { active: BotThreadRow[]; archived: BotThreadRow[] } {
  const shellsById = new Map(shells.map((shell) => [shell.id as string, shell] as const));
  const rows = links.flatMap((link): BotThreadRow[] => {
    if (link.botId !== botId) return [];
    const shell = shellsById.get(link.threadId);
    if (shell === undefined) return [];
    const parsed = Date.parse(shell.updatedAt);
    return [{ link, shell, updatedMs: Number.isNaN(parsed) ? 0 : parsed }];
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
