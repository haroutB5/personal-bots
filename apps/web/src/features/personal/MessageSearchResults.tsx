import type { JSX } from "react";
import { memo, useMemo } from "react";

import type {
  EnvironmentId,
  PersonalBot,
  PersonalBotSearchMessageHit,
  PersonalGroup,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";

import { useThreadShells } from "~/state/entities";

import { BotAvatar } from "./BotAvatar";
import { ROW_CLASS } from "./BotRow";
import { splitSnippet } from "./chatSearch";
import { GroupAvatarCluster } from "./GroupAvatarCluster";
import { activeGroupMembers } from "./groupModel";
import { requestMessageJump } from "./pendingMessageJump";
import { formatRelativeTime } from "./relativeTime";
import { useMessageSearch } from "./useMessageSearch";

const AVATAR_SIZE = 44;

function plainSnippet(snippet: string): string {
  return snippet.replace(/\s+/g, " ").trim();
}

/** The snippet with the words that matched drawn heavier, not highlighted. */
function Snippet({
  snippet,
  query,
}: {
  readonly snippet: string;
  readonly query: string;
}): JSX.Element {
  const segments = splitSnippet(plainSnippet(snippet), query).map((segment, index, all) => ({
    ...segment,
    // Where the run starts in the snippet: a key that is data, not a position.
    offset: all.slice(0, index).reduce((total, previous) => total + previous.text.length, 0),
  }));
  return (
    <span className="line-clamp-2 text-sm leading-5 break-words text-[var(--personal-text-secondary)]">
      {segments.map((segment) =>
        segment.match ? (
          <mark
            key={segment.offset}
            className="bg-transparent font-semibold text-[var(--personal-text)]"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.offset}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

const ArchivedPill = (): JSX.Element => (
  <span className="ml-2 shrink-0 rounded-full bg-[var(--personal-fill-muted)] px-2 text-[12px] leading-5 font-medium text-[var(--personal-text-secondary)]">
    Archived
  </span>
);

const HitRow = memo(function HitRow({
  hit,
  query,
  now,
  title,
  ownerName,
  face,
  link,
}: {
  readonly hit: PersonalBotSearchMessageHit;
  readonly query: string;
  readonly now: number;
  readonly title: string;
  /** The bot's or the group's name. */
  readonly ownerName: string;
  readonly face: JSX.Element;
  readonly link:
    | {
        readonly to: "/bots/$botId/$threadId";
        readonly params: { botId: string; threadId: string };
      }
    | { readonly to: "/bots/groups/$groupId"; readonly params: { groupId: string } };
}): JSX.Element {
  const createdAtMs = DateTime.toEpochMillis(hit.createdAt);
  const label = `${title}, ${ownerName}: ${plainSnippet(hit.snippet)}`;
  const content = (
    <>
      {face}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center">
          <span className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            {title}
          </span>
          {hit.archived ? <ArchivedPill /> : null}
          <time
            dateTime={new Date(createdAtMs).toISOString()}
            className="ml-auto shrink-0 pl-3 text-[13px] leading-[22px] text-[var(--personal-text-tertiary)]"
          >
            {formatRelativeTime(createdAtMs, now)}
          </time>
        </span>
        <Snippet snippet={hit.snippet} query={query} />
        {hit.moreInChat > 0 ? (
          <span className="text-[13px] leading-5 text-[var(--personal-text-tertiary)]">
            {`+${hit.moreInChat} more in this chat`}
          </span>
        ) : null}
      </span>
    </>
  );
  // A tap on the hit opens the chat and asks it to scroll to the message.
  const onClick = () => requestMessageJump(hit.threadId, hit.messageId);
  return link.to === "/bots/$botId/$threadId" ? (
    <Link
      to={link.to}
      params={link.params}
      aria-label={label}
      className={ROW_CLASS}
      onClick={onClick}
    >
      {content}
    </Link>
  ) : (
    <Link
      to={link.to}
      params={link.params}
      aria-label={label}
      className={ROW_CLASS}
      onClick={onClick}
    >
      {content}
    </Link>
  );
});

/**
 * "In messages": the chats whose messages match what was typed in the Chats
 * search, newest first, one row per chat. Quiet by design: nothing while there
 * is nothing to show, and a failed search looks like a search with no hits.
 */
export function MessageSearchResults({
  environmentId,
  query,
  now,
  bots,
  groups,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly query: string;
  readonly now: number;
  /** Every bot the owner has. */
  readonly bots: ReadonlyArray<PersonalBot>;
  /** Active and archived groups. */
  readonly groups: ReadonlyArray<PersonalGroup>;
}): JSX.Element | null {
  const search = useMessageSearch(environmentId, query);
  const shells = useThreadShells();
  const titles = useMemo(() => {
    const byId = new Map<string, string>();
    for (const shell of shells) {
      if (environmentId !== null && shell.environmentId !== environmentId) continue;
      if (shell.title.trim().length > 0) byId.set(shell.id as string, shell.title);
    }
    return byId;
  }, [environmentId, shells]);
  const botsById = useMemo(
    () => new Map(bots.map((bot) => [bot.botId as string, bot] as const)),
    [bots],
  );
  const groupsById = useMemo(
    () => new Map(groups.map((group) => [group.groupId as string, group] as const)),
    [groups],
  );

  if (search.hits.length === 0) {
    return search.status === "loading" ? (
      <p role="status" className="mt-4 text-[13px] leading-5 text-[var(--personal-text-tertiary)]">
        Searching in messages...
      </p>
    ) : null;
  }

  const rows: Array<JSX.Element> = [];
  for (const hit of search.hits) {
    const group = hit.groupId === null ? undefined : groupsById.get(hit.groupId);
    const bot = hit.botId === null ? undefined : botsById.get(hit.botId as string);
    if (hit.groupId !== null && group !== undefined) {
      const members = activeGroupMembers(group);
      const memberBots = members.flatMap((member) => {
        const memberBot = botsById.get(member.botId);
        return memberBot === undefined ? [] : [memberBot];
      });
      rows.push(
        <li key={hit.threadId}>
          <HitRow
            hit={hit}
            query={query}
            now={now}
            title={titles.get(hit.threadId) ?? group.name}
            ownerName={group.name}
            face={
              <GroupAvatarCluster
                bots={memberBots}
                memberCount={members.length}
                size={AVATAR_SIZE}
              />
            }
            link={{ to: "/bots/groups/$groupId", params: { groupId: group.groupId } }}
          />
        </li>,
      );
    } else if (hit.groupId === null && bot !== undefined) {
      rows.push(
        <li key={hit.threadId}>
          <HitRow
            hit={hit}
            query={query}
            now={now}
            title={titles.get(hit.threadId) ?? bot.name}
            ownerName={bot.name}
            face={
              <BotAvatar
                shape={bot.avatarShape}
                color={bot.avatarColor}
                size={AVATAR_SIZE}
                label={bot.name}
              />
            }
            link={{
              to: "/bots/$botId/$threadId",
              params: { botId: bot.botId, threadId: hit.threadId },
            }}
          />
        </li>,
      );
    }
  }
  if (rows.length === 0) return null;

  return (
    <section aria-label="In messages" className="mt-6">
      <h2 className="text-[15px] font-medium text-[var(--personal-text-secondary)]">In messages</h2>
      <ul className="mt-2 divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)] md:-mx-3">
        {rows}
      </ul>
      {search.capped ? (
        <p className="mt-3 text-[13px] leading-5 text-[var(--personal-text-tertiary)]">
          Showing the newest matches. Narrow the search for more.
        </p>
      ) : null}
    </section>
  );
}
