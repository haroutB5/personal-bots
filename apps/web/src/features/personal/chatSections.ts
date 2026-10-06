import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isGroupOnlyBot,
  type PersonalBot,
  type PersonalBotThread,
  type PersonalGroup,
} from "@t3tools/contracts";

import { chatActivityMs } from "./chatActivity";
import { snoozeEndMs, soonestWakeFirst } from "./chatState";
import { groupLastActivityMs, isGroupRelayLink } from "./groupModel";

/**
 * The section the Chats screen draws below the bot rows: the snoozed chats
 * and groups. A row is one chat (a thread of a bot) or one group. An archived
 * chat or group is not in it (archiving clears the snooze on the server).
 * Pinned chats are not listed here: a pin shows in the bot's own chat list
 * and chat chips (Harout, 1.65.1).
 */
export type ChatSectionRow =
  | {
      readonly kind: "chat";
      readonly key: string;
      readonly link: PersonalBotThread;
      readonly shell: EnvironmentThreadShell;
      readonly bot: PersonalBot;
      readonly activityMs: number;
      /** Epoch ms the snooze ends; null when awake. */
      readonly wakeMs: number | null;
    }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly group: PersonalGroup;
      readonly activityMs: number;
      readonly wakeMs: number | null;
    };

export interface ChatSections {
  /** Soonest wake first. */
  readonly snoozed: ReadonlyArray<ChatSectionRow>;
}

export function buildChatSections(input: {
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly links: ReadonlyArray<PersonalBotThread>;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  /** Groups that are not archived. */
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly relayThreadIds: ReadonlySet<string>;
  readonly nowMs: number;
}): ChatSections {
  const botsById = new Map(input.bots.map((bot) => [bot.botId as string, bot] as const));
  const shellsById = new Map(input.shells.map((shell) => [shell.id as string, shell] as const));
  const rows: ChatSectionRow[] = [];
  for (const link of input.links) {
    if (link.archivedAt !== null || isGroupRelayLink(link, input.relayThreadIds)) continue;
    const wakeMs = snoozeEndMs(link, input.nowMs);
    if (wakeMs === null) continue;
    const bot = botsById.get(link.botId);
    const shell = shellsById.get(link.threadId);
    if (bot === undefined || shell === undefined || shell.archivedAt !== null) continue;
    if (isGroupOnlyBot(bot)) continue;
    rows.push({
      kind: "chat",
      key: link.threadId,
      link,
      shell,
      bot,
      activityMs: chatActivityMs(shell, link),
      wakeMs,
    });
  }
  for (const group of input.groups) {
    const wakeMs = snoozeEndMs(group, input.nowMs);
    if (wakeMs === null) continue;
    rows.push({
      kind: "group",
      key: group.groupId,
      group,
      activityMs: groupLastActivityMs(group, input.nowMs),
      wakeMs,
    });
  }
  const newestFirst = rows.toSorted((left, right) => right.activityMs - left.activityMs);
  return { snoozed: soonestWakeFirst(newestFirst, (row) => row.wakeMs ?? 0) };
}

/**
 * The groups (not archived) the Chats list shows among its rows: the awake ones. A pinned
 * group stays among them: it has no bot chat list to be pinned in.
 */
export function plainGroups(
  groups: ReadonlyArray<PersonalGroup>,
  nowMs: number,
): ReadonlyArray<PersonalGroup> {
  return groups.filter((group) => snoozeEndMs(group, nowMs) === null);
}

/** What the section search matches: the chat's title and its bot, or the group's name. */
export function sectionRowMatches(
  row: ChatSectionRow,
  query: string,
  groupMemberNames: (group: PersonalGroup) => ReadonlyArray<string>,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return true;
  const texts =
    row.kind === "chat"
      ? [row.shell.title, row.bot.name]
      : [row.group.name, ...groupMemberNames(row.group)];
  return texts.some((text) => text.toLocaleLowerCase().includes(needle));
}
