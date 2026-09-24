import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isGroupOnlyBot,
  isTeamLead,
  type PersonalBot,
  type PersonalBotThread,
  type PersonalGroup,
} from "@t3tools/contracts";

import { activeGroupMembers } from "./groupModel";

/**
 * Group-only bots (in a group, no private chat of their own; the server
 * derives it on `personalBots.list`) live inside their groups: the Chats list,
 * its search and the pinned strip leave them out, and the group's settings are
 * where the owner reaches them. Everything else about the bot is untouched.
 */
export function shownInChats<T extends { readonly bot: PersonalBot }>(
  rows: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return rows.filter((row) => !isGroupOnlyBot(row.bot));
}

/**
 * The Team chart's bots. A group-only bot stays out, unless it leads a team:
 * a team drawn without its lead would be a broken chart, not a tidier one.
 */
export function shownInTeamChart(bots: ReadonlyArray<PersonalBot>): ReadonlyArray<PersonalBot> {
  return bots.filter((bot) => !isGroupOnlyBot(bot) || isTeamLead(bot));
}

/**
 * The text of the Remove confirmation. It says where the bot will be
 * afterwards, because a bot that lives only in this group would otherwise
 * seem to vanish: it never does, it goes back to the Bots list.
 */
export function memberRemovalMessage(input: {
  readonly bot: Pick<PersonalBot, "name" | "groupIds" | "groupOnly"> | null;
  readonly botName: string;
  readonly group: Pick<PersonalGroup, "groupId" | "name">;
  readonly groups: ReadonlyArray<Pick<PersonalGroup, "groupId" | "name">>;
}): string {
  const lead = `Remove ${input.botName} from ${input.group.name}?`;
  if (input.bot === null) return `${lead}\nIts own chats are kept.`;
  const others = (input.bot.groupIds ?? []).filter((groupId) => groupId !== input.group.groupId);
  if (others.length > 0) {
    const names = others.flatMap((groupId) => {
      const match = input.groups.find((group) => group.groupId === groupId);
      return match === undefined ? [] : [match.name];
    });
    const where =
      names.length === 1
        ? names[0]!
        : names.length > 1
          ? `${String(names.length)} other groups`
          : "another group";
    return `${lead}\nIt stays in ${where}.`;
  }
  if (isGroupOnlyBot(input.bot)) {
    return `${lead}\nIt isn't in any other group, so it moves back to your Bots list. Nothing is deleted.`;
  }
  return `${lead}\nIt stays in your Bots list with its own chats.`;
}

/**
 * The chat "Message privately" opens: the bot's newest empty private chat if
 * it has one (an earlier tap that was never written in), so repeated taps do
 * not pile up blank chats; null means start a new one.
 *
 * Private means linked to the bot, not archived, and not one of any group's
 * relay threads. Empty means no message and no turn yet on its thread shell.
 */
export function reusablePrivateChat(input: {
  readonly botId: string;
  readonly links: ReadonlyArray<PersonalBotThread>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly relayThreadIds: ReadonlySet<string>;
}): string | null {
  const shellsById = new Map(input.shells.map((shell) => [shell.id as string, shell] as const));
  const candidates = input.links.flatMap((link) => {
    if (link.botId !== input.botId || link.archivedAt !== null) return [];
    if (input.relayThreadIds.has(link.threadId)) return [];
    if (link.newestMessage != null) return [];
    const shell = shellsById.get(link.threadId);
    if (shell === undefined || shell.archivedAt !== null) return [];
    if (shell.latestTurn != null || shell.latestUserMessageAt != null) return [];
    return [{ threadId: link.threadId as string, createdAt: shell.createdAt }];
  });
  const newest = candidates.toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  )[0];
  return newest?.threadId ?? null;
}

/** Enabled bots not already in the group, by name: the Add member choices. */
export function addableBots(
  bots: ReadonlyArray<PersonalBot>,
  group: PersonalGroup,
): ReadonlyArray<PersonalBot> {
  const members = new Set(activeGroupMembers(group).map((member) => member.botId as string));
  return bots
    .filter((bot) => bot.enabled && !members.has(bot.botId))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}
