import type { JSX } from "react";

import type { PersonalBot, PersonalGroup, PersonalGroupRound } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import { plainPreviewLine, ROW_CLASS } from "./BotRow";
import { chatNoticeLabel, readChatNotice } from "./chatNotices";
import type { ChatSectionRow } from "./chatSections";
import { wakeLabel } from "./chatState";
import { GroupRow } from "./GroupRow";
import { PinMark } from "./PinMark";
import { roundForGroup } from "./groupModel";
import { HIDDEN_PREVIEW_LABEL, hidesBotPreviews } from "./previewPrivacy";
import { formatRelativeTime } from "./relativeTime";
import { UnreadDot } from "./UnreadChatsBadge";

type Row = ChatSectionRow;
type ChatRow = Extract<Row, { kind: "chat" }>;

/** The chat's last message as one line; nothing when there is none. */
export function sectionChatPreview(row: ChatRow): string {
  const message = row.link.newestMessage;
  if (message === null || message === undefined) return "";
  if (hidesBotPreviews(row.bot) || message.hidden === true) return HIDDEN_PREVIEW_LABEL;
  const notice = readChatNotice(message);
  if (notice !== null) return chatNoticeLabel(notice, message.text, Date.now());
  return (
    message.text
      .split("\n")
      .map((part) => plainPreviewLine(part))
      .find((part) => part.length > 0) ?? ""
  );
}

const ACTION_BUTTON =
  "flex h-11 shrink-0 items-center justify-center rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3 text-sm font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

export interface ChatSectionActions {
  readonly onUnpin: (row: Row) => void;
  readonly onSnooze: (row: Row) => void;
  /** Chats only: a group has no unread state. */
  readonly onMarkUnread: (row: Row) => void;
  readonly onWake: (row: Row) => void;
}

function rowName(row: Row): string {
  return row.kind === "chat" ? row.shell.title : row.group.name;
}

/** The "..." of a pinned row: Unpin, Snooze and, for a chat, Mark unread. */
function PinnedRowMenu({
  row,
  actions,
}: {
  readonly row: Row;
  readonly actions: ChatSectionActions;
}): JSX.Element {
  const name = rowName(row);
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Options for ${name}`}
            className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          />
        }
      >
        <Ellipsis aria-hidden="true" className="size-5" strokeWidth={1.75} />
      </MenuTrigger>
      <MenuPopup align="end" className="personal-app personal-menu min-w-48">
        <MenuItem onClick={() => actions.onUnpin(row)}>
          {row.kind === "chat" ? "Unpin chat" : "Unpin group"}
        </MenuItem>
        <MenuItem onClick={() => actions.onSnooze(row)}>Snooze…</MenuItem>
        {row.kind === "chat" ? (
          <MenuItem onClick={() => actions.onMarkUnread(row)}>Mark unread</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** A chat in a section: the bot's face, the chat's title, the bot's name and one more line. */
function ChatRowLink({
  row,
  now,
  unread,
  pinned,
  detail,
}: {
  readonly row: ChatRow;
  readonly now: number;
  readonly unread: boolean;
  readonly pinned: boolean;
  /** The third line: a pinned chat shows its last message, a snoozed one when it wakes. */
  readonly detail: string;
}): JSX.Element {
  const title = row.shell.title;
  const spoken = [
    pinned ? "pinned" : null,
    unread ? "unread" : null,
    row.wakeMs === null ? null : wakeLabel(row.wakeMs, now).toLowerCase(),
  ].filter((part) => part !== null);
  return (
    <Link
      to="/bots/$botId/$threadId"
      params={{ botId: row.bot.botId, threadId: row.link.threadId }}
      aria-label={`${title}, ${row.bot.name}${spoken.length === 0 ? "" : `, ${spoken.join(", ")}`}`}
      className={cn(ROW_CLASS, "min-w-0 flex-1")}
    >
      <BotAvatar shape={row.bot.avatarShape} color={row.bot.avatarColor} size={56} label="" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center">
          {unread ? <UnreadDot className="mr-2" /> : null}
          <span
            className={cn(
              "truncate text-[17px] leading-[22px] text-[var(--personal-text)]",
              unread ? "font-bold" : "font-semibold",
            )}
          >
            {title}
          </span>
          {pinned ? <PinMark /> : null}
          {row.wakeMs === null ? (
            <time
              dateTime={new Date(row.activityMs).toISOString()}
              className="ml-auto shrink-0 pl-3 text-[13px] leading-[22px] text-[var(--personal-text-tertiary)]"
            >
              {formatRelativeTime(row.activityMs, now)}
            </time>
          ) : null}
        </span>
        <span className="truncate text-sm leading-5 text-[var(--personal-text-secondary)]">
          {row.bot.name}
        </span>
        {detail === "" ? null : (
          <span className="truncate text-sm leading-5 text-[var(--personal-text-preview)]">
            {detail}
          </span>
        )}
      </span>
    </Link>
  );
}

/**
 * The pinned chats and groups at the top of the Chats screen: each row looks
 * like the chat's own row with a small pin, a tap opens it, and a "..." opens
 * Unpin, Snooze and Mark unread (a group has no unread state, so no Mark unread).
 */
export function PinnedChatList({
  rows,
  now,
  unreadThreadIds,
  rounds,
  memberBotsOf,
  actions,
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly now: number;
  readonly unreadThreadIds: ReadonlySet<string>;
  readonly rounds: ReadonlyArray<PersonalGroupRound>;
  readonly memberBotsOf: (group: PersonalGroup) => ReadonlyArray<PersonalBot>;
  readonly actions: ChatSectionActions;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Pinned chats" data-testid="pinned-chats" className="mt-3">
      <h2 className="text-[13px] font-semibold tracking-wide text-[var(--personal-text-secondary)] uppercase">
        Pinned
      </h2>
      <ul className="personal-row-list divide-y divide-[var(--personal-border)] border-y border-[var(--personal-border)] md:-mx-3">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center">
            {row.kind === "chat" ? (
              <ChatRowLink
                row={row}
                now={now}
                pinned
                unread={unreadThreadIds.has(row.link.threadId)}
                detail={sectionChatPreview(row)}
              />
            ) : (
              <div className="min-w-0 flex-1">
                <GroupRow
                  group={row.group}
                  round={roundForGroup(rounds, row.group.groupId)}
                  bots={memberBotsOf(row.group)}
                  now={now}
                  pinned
                />
              </div>
            )}
            <PinnedRowMenu row={row} actions={actions} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The snoozed chats and groups: one collapsed section like the archived ones,
 * each row with its wake time and a "Wake now" button.
 */
export function SnoozedChatList({
  rows,
  now,
  rounds,
  memberBotsOf,
  actions,
  busy = false,
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly now: number;
  readonly rounds: ReadonlyArray<PersonalGroupRound>;
  readonly memberBotsOf: (group: PersonalGroup) => ReadonlyArray<PersonalBot>;
  readonly actions: ChatSectionActions;
  readonly busy?: boolean;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <details className="mt-6" data-testid="snoozed-chats">
      <summary className="flex min-h-11 cursor-pointer items-center text-[15px] font-medium text-[var(--personal-text-secondary)]">
        Snoozed ({rows.length})
      </summary>
      <ul
        aria-label="Snoozed chats"
        className="personal-row-list divide-y divide-[var(--personal-border)] md:-mx-3"
      >
        {rows.map((row) => {
          const wake = wakeLabel(row.wakeMs ?? now, now);
          return (
            <li key={row.key} className="flex items-center gap-2">
              {row.kind === "chat" ? (
                <ChatRowLink row={row} now={now} pinned={false} unread={false} detail={wake} />
              ) : (
                <div className="min-w-0 flex-1">
                  <GroupRow
                    group={row.group}
                    round={roundForGroup(rounds, row.group.groupId)}
                    bots={memberBotsOf(row.group)}
                    now={now}
                    wakeText={wake}
                  />
                </div>
              )}
              <button
                type="button"
                disabled={busy}
                aria-label={`Wake ${rowName(row)} now`}
                onClick={() => actions.onWake(row)}
                className={ACTION_BUTTON}
              >
                Wake now
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
