import type { JSX } from "react";

import type { PersonalBot, PersonalGroup, PersonalGroupRound } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import { ROW_CLASS } from "./BotRow";
import type { ChatSectionRow } from "./chatSections";
import { wakeLabel } from "./chatState";
import { GroupRow } from "./GroupRow";
import { roundForGroup } from "./groupModel";

type Row = ChatSectionRow;
type ChatRow = Extract<Row, { kind: "chat" }>;

const ACTION_BUTTON =
  "flex h-11 shrink-0 items-center justify-center rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3 text-sm font-medium text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

export interface ChatSectionActions {
  readonly onWake: (row: Row) => void;
}

function rowName(row: Row): string {
  return row.kind === "chat" ? row.shell.title : row.group.name;
}

/** A snoozed chat: the bot's face, the chat's title, the bot's name and when it wakes. */
function ChatRowLink({
  row,
  now,
  detail,
}: {
  readonly row: ChatRow;
  readonly now: number;
  /** The third line: when the chat wakes. */
  readonly detail: string;
}): JSX.Element {
  const title = row.shell.title;
  const spoken = row.wakeMs === null ? null : wakeLabel(row.wakeMs, now).toLowerCase();
  return (
    <Link
      to="/bots/$botId/$threadId"
      params={{ botId: row.bot.botId, threadId: row.link.threadId }}
      aria-label={`${title}, ${row.bot.name}${spoken === null ? "" : `, ${spoken}`}`}
      className={cn(ROW_CLASS, "min-w-0 flex-1")}
    >
      <BotAvatar shape={row.bot.avatarShape} color={row.bot.avatarColor} size={56} label="" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center">
          <span className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            {title}
          </span>
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
 * The snoozed chats and groups: one collapsed section like the archived ones,
 * each row with its wake time and a "Wake now" button. Pinned chats are not
 * listed on the Bots page: a pin shows in the bot's own chat list.
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
                <ChatRowLink row={row} now={now} detail={wake} />
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
