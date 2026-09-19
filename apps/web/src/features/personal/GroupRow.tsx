import type { JSX } from "react";
import { memo } from "react";

import type { PersonalBot, PersonalGroup, PersonalGroupRound } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import { ROW_CLASS } from "./BotRow";
import { GroupAvatarCluster } from "./GroupAvatarCluster";
import {
  activeGroupMembers,
  groupLastActivityMs,
  groupPreviewLine,
  groupStatusLine,
  groupSubtitle,
  isGroupRoundLive,
} from "./groupModel";
import { formatRelativeTime } from "./relativeTime";

/**
 * A group in the Chats list. Same row as a bot — same class, same three lines,
 * same timestamp slot — because a group is a chat, not a new kind of object
 * [Grok: no new surface]. Only the face differs: a cluster of its members
 * instead of one avatar.
 */
export const GroupRow = memo(function GroupRow({
  group,
  round,
  bots,
  now,
}: {
  readonly group: PersonalGroup;
  /** The group's live round, or null. Drives the working dot and the status. */
  readonly round: PersonalGroupRound | null;
  /** Member bots that have loaded, in sort order. */
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly now: number;
}): JSX.Element {
  const members = activeGroupMembers(group);
  const nameOf = (botId: string) =>
    bots.find((candidate) => candidate.botId === botId)?.name ?? null;
  const status = groupStatusLine(round, nameOf);
  const live = isGroupRoundLive(round);
  const lastActivityMs = groupLastActivityMs(group);

  return (
    <Link
      to="/bots/groups/$groupId"
      params={{ groupId: group.groupId }}
      // The cluster says "group" visually; this says it to a screen reader,
      // which would otherwise hear a row that looks like every bot row.
      aria-label={`${group.name}, group chat`}
      className={ROW_CLASS}
    >
      <GroupAvatarCluster bots={bots} memberCount={members.length} size={56} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center">
          <span className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            {group.name}
          </span>
          {live ? (
            <span className="ml-2 flex shrink-0 items-center">
              <span aria-hidden="true" className="size-2 rounded-full bg-[var(--personal-live)]" />
              <span className="sr-only">, working</span>
            </span>
          ) : null}
          <time
            dateTime={new Date(lastActivityMs).toISOString()}
            className="ml-auto shrink-0 pl-3 text-[13px] leading-[22px] text-[var(--personal-text-tertiary)]"
          >
            {formatRelativeTime(lastActivityMs, now)}
          </time>
        </span>
        <span
          className={cn(
            "truncate text-sm leading-5",
            status.tone === "review"
              ? "text-[var(--personal-review)]"
              : "text-[var(--personal-text-secondary)]",
          )}
        >
          {groupSubtitle(group, nameOf)}
          {status.label === "Ready" ? "" : ` · ${status.label}`}
        </span>
        <span className="truncate text-sm leading-5 text-[var(--personal-text-preview)]">
          {groupPreviewLine(group)}
        </span>
      </span>
    </Link>
  );
});
