import type { PersonalBot, PersonalGroup, PersonalGroupRound } from "@t3tools/contracts";

import { formatRelativeTime } from "@hbots/personal-client/bots/relativeTime";
import {
  activeGroupMembers,
  groupLastActivityMs,
  groupPreviewLine,
  groupStatusLine,
  groupSubtitle,
  roundForGroup,
} from "@hbots/personal-client/conversation/groupModel";

/**
 * One row in the Chats list's Groups section. The words come from the shared
 * group model, so the phone and the web describe a group the same way.
 */
export interface GroupRowModel {
  readonly groupId: string;
  readonly name: string;
  /** Active members in the group's order, so the row can draw their faces. */
  readonly memberIds: ReadonlyArray<string>;
  readonly subtitle: string;
  readonly preview: string;
  readonly timeLabel: string;
  readonly statusLabel: string;
  readonly tone: "review" | "normal";
  readonly live: boolean;
  readonly archived: boolean;
}

export function groupRowModel(input: {
  readonly group: PersonalGroup;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly round: PersonalGroupRound | null;
  readonly nowMs: number;
}): GroupRowModel {
  const botsById = new Map(input.bots.map((bot) => [bot.botId as string, bot] as const));
  const nameOf = (botId: string): string | null => botsById.get(botId)?.name ?? null;
  const archived = input.group.archivedAt !== null;
  const status = groupStatusLine(input.round, nameOf, { archived });
  return {
    groupId: input.group.groupId,
    name: input.group.name,
    memberIds: activeGroupMembers(input.group).map((member) => member.botId),
    subtitle: groupSubtitle(input.group, nameOf),
    preview: groupPreviewLine(input.group),
    timeLabel: formatRelativeTime(groupLastActivityMs(input.group, input.nowMs), input.nowMs),
    statusLabel: status.label,
    tone: status.tone,
    live: input.round?.status === "running" || input.round?.status === "waiting_provider",
    archived,
  };
}

export interface GroupChatsSections {
  readonly groups: ReadonlyArray<GroupRowModel>;
  readonly archived: ReadonlyArray<GroupRowModel>;
}

/**
 * The Groups section of the Chats list: live groups newest first, archived
 * groups kept reachable below them. Never mixes a group into a bot row: a bot
 * row opens one speaker's chat, a group row opens the round's transcript.
 */
export function groupChatsSections(input: {
  readonly groups: ReadonlyArray<PersonalGroup>;
  readonly archivedGroups: ReadonlyArray<PersonalGroup>;
  readonly rounds: ReadonlyArray<PersonalGroupRound>;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly nowMs: number;
}): GroupChatsSections {
  const row = (group: PersonalGroup): GroupRowModel =>
    groupRowModel({
      group,
      bots: input.bots,
      round: roundForGroup(input.rounds, group.groupId),
      nowMs: input.nowMs,
    });
  const newestFirst = (list: ReadonlyArray<PersonalGroup>): ReadonlyArray<GroupRowModel> =>
    Object.freeze(
      list
        .toSorted(
          (left, right) =>
            groupLastActivityMs(right, input.nowMs) - groupLastActivityMs(left, input.nowMs),
        )
        .map(row),
    );
  return {
    groups: newestFirst(input.groups),
    archived: newestFirst(input.archivedGroups),
  };
}

export type GroupScreenState =
  | { readonly kind: "loading" }
  | { readonly kind: "gone" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready" };

/**
 * The group page's four states. `listLoaded` is false until the list query
 * answers; only after that can "not found" mean the group is gone rather than
 * still arriving.
 */
export function groupScreenState(input: {
  readonly listLoaded: boolean;
  readonly listError: string | null;
  readonly groupExists: boolean;
}): GroupScreenState {
  if (input.listError !== null) return { kind: "error", message: input.listError };
  if (!input.listLoaded) return { kind: "loading" };
  if (!input.groupExists) return { kind: "gone" };
  return { kind: "ready" };
}

export type GroupMenuActionKey =
  | "settings"
  | "stop"
  | "pin"
  | "snooze"
  | "unarchive"
  | "archive"
  | "delete";

export interface GroupMenuAction {
  readonly key: GroupMenuActionKey;
  readonly label: string;
  readonly destructive: boolean;
  readonly disabled: boolean;
}

/**
 * The conversation's "..." menu. Stop exists only while a round owns the
 * group; an archived group offers Unarchive instead of pin and snooze, which
 * would be edits to a conversation that is read-only.
 */
export function groupMenuActions(input: {
  readonly live: boolean;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly unarchiving: boolean;
}): ReadonlyArray<GroupMenuAction> {
  const actions: GroupMenuAction[] = [
    { key: "settings", label: "Group settings", destructive: false, disabled: false },
  ];
  if (input.live) {
    actions.push({ key: "stop", label: "Stop", destructive: false, disabled: false });
  }
  if (input.archived) {
    actions.push({
      key: "unarchive",
      label: "Unarchive group",
      destructive: false,
      disabled: input.unarchiving,
    });
  } else {
    actions.push(
      {
        key: "pin",
        label: input.pinned ? "Unpin group" : "Pin group",
        destructive: false,
        disabled: false,
      },
      { key: "snooze", label: "Snooze", destructive: false, disabled: false },
      { key: "archive", label: "Archive group", destructive: false, disabled: false },
    );
  }
  actions.push({ key: "delete", label: "Delete group", destructive: true, disabled: false });
  return actions;
}

export type GroupComposerMode =
  | { readonly kind: "send" }
  | { readonly kind: "stop" }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * What the composer offers. A live round turns the send button into Stop. An
 * empty group cannot open a round, and an archived group is read-only.
 */
export function groupComposerMode(input: {
  readonly archived: boolean;
  readonly live: boolean;
  readonly memberCount: number;
}): GroupComposerMode {
  if (input.archived) return { kind: "blocked", reason: "Unarchive to send messages again." };
  if (input.memberCount === 0) {
    return { kind: "blocked", reason: "This group has no bots in it yet." };
  }
  if (input.live) return { kind: "stop" };
  return { kind: "send" };
}

/** Name validation, worded once so the form and its tests agree. */
export function groupNameError(name: string): string | null {
  return name.trim().length === 0 ? "Give the group a name." : null;
}

/** The web's minimum is two: a group of one is a chat. */
export function groupMembersError(count: number): string | null {
  return count < 2 ? "Pick at least two bots. A group of one is a chat." : null;
}
