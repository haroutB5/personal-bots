import type { JSX, ReactNode } from "react";
import { memo } from "react";

import type { PersonalBot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { cn } from "~/lib/utils";

import type { AvatarMotion } from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import { SELECTED_ROW_CLASS, selectedChatProps } from "./BotRow";
import { GroupFacePair } from "./GroupFacePair";
import { groupPreviewLine, groupStatusLine, isGroupRoundLive } from "./groupModel";
import type { HomeChatRow, HomeGroupRow, RowPreviewTone } from "./homeRows";
import { NEEDS_YOU_PILL_LABEL, NEEDS_YOU_WORDS, type NeedsYouRequest } from "./needsYou";
import { perfOptimizationOn } from "./perfFlags";
import { formatRelativeTime } from "./relativeTime";

/**
 * One home row: 72 px tall across every bot, 48 px avatar, the title with its
 * time on line 1 and "<bot>: preview" with the pill or the unread badge on
 * line 2. Groups use the same row with the two-face cluster, because a group
 * is a chat.
 *
 * The pill is part of the row's tap target, never its own button: one action
 * per row, and that action is "open the chat at the request" (no in-place
 * actions, no Undo). It is a deep link by construction: the whole row is one
 * <a> to the chat.
 */

export const HOME_ROW_CLASS = cn(
  "home-row relative flex h-[72px] w-full min-w-0 items-center gap-3 px-4 text-left outline-none",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)] personal-row-hover",
);

/** The pill: a calm deep link. Neutral fill, the amber dot carries the state. */
export function NeedsYouPill({ request }: { readonly request: NeedsYouRequest }): JSX.Element {
  return (
    <span
      data-testid="needs-pill"
      data-kind={request.kind}
      className="flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-[var(--personal-fill-muted)] pr-1.5 pl-2.5 text-[13px] leading-4 font-semibold text-[var(--personal-text)]"
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-[var(--personal-state-needs)]"
      />
      {/* Its own element: the label is a leaf in the row's markup, so a
          reader (or a check) that looks for the pill's word finds it. */}
      <span>{NEEDS_YOU_PILL_LABEL[request.kind]}</span>
      <ChevronRight
        aria-hidden="true"
        className="size-3 shrink-0 text-[var(--personal-text-secondary)]"
        strokeWidth={2.4}
      />
    </span>
  );
}

/** The row's two lines: the title with its time, then the preview with its pill. */
function RowContent({
  avatar,
  title,
  timeMs,
  now,
  unread,
  who,
  preview,
  tone,
  request,
}: {
  readonly avatar: ReactNode;
  readonly title: string;
  readonly timeMs: number;
  readonly now: number;
  readonly unread: boolean;
  readonly who: string;
  readonly preview: string;
  readonly tone: RowPreviewTone;
  readonly request: NeedsYouRequest | null;
}): JSX.Element {
  return (
    <>
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex h-[22px] min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]",
              unread && "font-bold",
            )}
          >
            {title}
          </span>
          <time
            dateTime={new Date(timeMs).toISOString()}
            className={cn(
              "ml-auto shrink-0 text-[13px] leading-[22px] tabular-nums",
              unread
                ? "font-semibold text-[var(--personal-text)]"
                : "text-[var(--personal-text-tertiary)]",
            )}
          >
            {formatRelativeTime(timeMs, now)}
          </time>
        </span>
        <span className="flex h-6 min-w-0 items-center gap-2 text-[15px] leading-5">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              unread ? "text-[var(--personal-text)]" : "text-[var(--personal-text-preview)]",
            )}
          >
            <span className="text-[var(--personal-text-secondary)]">{who}:</span>{" "}
            <span
              className={cn(
                tone === "working" && "text-[var(--personal-state-working)]",
                tone === "thinking" && "text-[var(--personal-state-thinking)]",
              )}
            >
              {preview}
            </span>
          </span>
          {request !== null ? <NeedsYouPill request={request} /> : null}
          {unread && request === null ? (
            <span
              data-testid="unread-badge"
              className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--personal-primary)] px-1.5 text-[12px] leading-5 font-bold text-[var(--personal-primary-text)] tabular-nums"
            >
              1
            </span>
          ) : null}
        </span>
      </span>
    </>
  );
}

/**
 * A chat row's accessible name: the same words a person reads, plus what the
 * pill will do ("Opens the chat at the request"), because the pill itself is
 * decoration inside the link.
 */
function chatRowLabel(input: {
  readonly title: string;
  readonly botName: string;
  readonly preview: string;
  readonly request: NeedsYouRequest | null;
}): string {
  if (input.request !== null) {
    return `${input.title}, ${input.botName}, ${NEEDS_YOU_WORDS[input.request.kind]}: ${input.preview}. Opens the chat at the request`;
  }
  return `${input.title}, ${input.botName}: ${input.preview}`;
}

interface HomeChatRowViewProps {
  readonly row: HomeChatRow;
  readonly preview: string;
  readonly tone: RowPreviewTone;
  readonly now: number;
  readonly selected?: boolean | undefined;
  readonly motion?: AvatarMotion | undefined;
  readonly comet?: boolean | undefined;
  readonly posInSet?: number | undefined;
  readonly setSize?: number | undefined;
}

/**
 * Kill switch "home-row-memo" (perfFlags.ts), read once per load. The home
 * rebuilds every row object on each store change, so the default shallow
 * comparison always saw a new `row` and drew all of them again. This compares
 * the fields the row actually draws: the title and time, the avatar, the
 * unread mark and the request's kind. Add any field the view starts to read.
 */
const ROW_MEMO_ON = perfOptimizationOn("home-row-memo");

function sameChatRowProps(previous: HomeChatRowViewProps, next: HomeChatRowViewProps): boolean {
  if (previous === next) return true;
  const a = previous.row;
  const b = next.row;
  return (
    previous.preview === next.preview &&
    previous.tone === next.tone &&
    previous.now === next.now &&
    previous.selected === next.selected &&
    previous.motion === next.motion &&
    previous.comet === next.comet &&
    previous.posInSet === next.posInSet &&
    previous.setSize === next.setSize &&
    (a === b ||
      (a.key === b.key &&
        a.title === b.title &&
        a.activityMs === b.activityMs &&
        a.unread === b.unread &&
        a.link.threadId === b.link.threadId &&
        a.bot.botId === b.bot.botId &&
        a.bot.name === b.bot.name &&
        a.bot.avatarShape === b.bot.avatarShape &&
        a.bot.avatarColor === b.bot.avatarColor &&
        (a.request === b.request ||
          (a.request !== null && b.request !== null && a.request.kind === b.request.kind))))
  );
}

function HomeChatRowViewImpl({
  row,
  preview,
  tone,
  now,
  selected = false,
  motion,
  comet = false,
  posInSet,
  setSize,
}: {
  readonly row: HomeChatRow;
  readonly preview: string;
  readonly tone: RowPreviewTone;
  readonly now: number;
  readonly selected?: boolean | undefined;
  readonly motion?: AvatarMotion | undefined;
  readonly comet?: boolean | undefined;
  /**
   * This row's place in the whole list (1-based) and the list's length. The
   * list is windowed (homeWindow.ts): only the rows near the viewport are
   * drawn, so these tell a screen reader the full count and the row's real
   * place in it.
   */
  readonly posInSet?: number | undefined;
  readonly setSize?: number | undefined;
}): JSX.Element {
  return (
    <li aria-posinset={posInSet} aria-setsize={setSize}>
      <Link
        to="/bots/$botId/$threadId"
        params={{ botId: row.bot.botId, threadId: row.link.threadId }}
        data-testid="home-chat-row"
        aria-label={chatRowLabel({
          title: row.title,
          botName: row.bot.name,
          preview,
          request: row.request,
        })}
        className={cn(HOME_ROW_CLASS, selected && SELECTED_ROW_CLASS)}
        {...selectedChatProps(selected)}
      >
        <RowContent
          avatar={
            <BotAvatar
              shape={row.bot.avatarShape}
              color={row.bot.avatarColor}
              size={48}
              label={row.bot.name}
              motion={motion}
              compactIdle
              comet={comet}
              thought="row"
            />
          }
          title={row.title}
          timeMs={row.activityMs}
          now={now}
          unread={row.unread}
          who={row.bot.name}
          preview={preview}
          tone={tone}
          request={row.request}
        />
      </Link>
    </li>
  );
}

export const HomeChatRowView = memo(
  HomeChatRowViewImpl,
  ROW_MEMO_ON ? sameChatRowProps : undefined,
);

export const HomeGroupRowView = memo(function HomeGroupRowView({
  row,
  bots,
  nameOf,
  now,
  selected = false,
  posInSet,
  setSize,
}: {
  readonly row: HomeGroupRow;
  /** Member bots that have loaded, in sort order. */
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly nameOf: (botId: string) => string | null;
  readonly now: number;
  readonly selected?: boolean | undefined;
  /** See HomeChatRowView: the row's place in the windowed list, and its length. */
  readonly posInSet?: number | undefined;
  readonly setSize?: number | undefined;
}): JSX.Element {
  const live = isGroupRoundLive(row.round);
  const status = groupStatusLine(row.round, nameOf);
  const preview = live ? status.label : groupPreviewLine(row.group);
  const tone: RowPreviewTone = live ? "working" : "plain";
  return (
    <li aria-posinset={posInSet} aria-setsize={setSize}>
      <Link
        to="/bots/groups/$groupId"
        params={{ groupId: row.group.groupId }}
        data-testid="home-group-row"
        aria-label={
          row.request === null
            ? `${row.group.name}, Group: ${preview}`
            : `${row.group.name}, Group, ${NEEDS_YOU_WORDS[row.request.kind]}: ${preview}. Opens the chat at the request`
        }
        className={cn(HOME_ROW_CLASS, selected && SELECTED_ROW_CLASS)}
        {...selectedChatProps(selected)}
      >
        <RowContent
          avatar={<GroupFacePair bots={bots} />}
          title={row.group.name}
          timeMs={row.activityMs}
          now={now}
          unread={false}
          who="Group"
          preview={preview}
          tone={tone}
          request={row.request}
        />
      </Link>
    </li>
  );
});
