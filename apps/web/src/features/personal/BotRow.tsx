import type { JSX, ReactNode } from "react";
import { memo } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import type { AvatarMotion } from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import { botStatus, type BotSummary } from "./botSummaries";
import { readServerTurn, type ServerTurn } from "./delegationModel";
import { formatRelativeTime } from "./relativeTime";
import { useStartBotChat } from "./startBotChat";

/**
 * md+ (the desktop bot list) pads the row by 12px, and the list pulls itself
 * out by the same amount (`md:-mx-3` in ChatsScreen), so the content stays on
 * the header's edge while the selected fill gets room either side of it.
 */
export const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-[18px] py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)] md:px-3";

/**
 * The row of the chat open in the desktop pane: a muted fill between the
 * dividers plus a short primary bar at its leading edge. Every row text token
 * clears AA on `--personal-fill-muted` (pinned in personalThemeContrast), and
 * the bar clears the 3:1 non-text bar in both appearances. md+ only, so the
 * phone, where the list and the chat are separate screens, never shows it.
 *
 * No clash with the swipe layer: the fill is the row's own background, which
 * slides with the row over the layer's page colour. Rows have no hover or
 * pressed background to fight with.
 *
 * Inside the row the page token becomes the fill (as `.personal-pane` does for
 * the pane), so whatever is cut out "in the page colour" (the group cluster's
 * rings, a badge ring) matches the fill instead of drawing dark boxes on it.
 */
export const SELECTED_ROW_CLASS = cn(
  "md:relative md:rounded-[var(--personal-radius-button)] md:bg-[var(--personal-fill-muted)]",
  "md:[--personal-bg:var(--personal-fill-muted)]",
  "md:before:absolute md:before:inset-y-6 md:before:left-1 md:before:w-[3px]",
  "md:before:rounded-full md:before:bg-[var(--personal-primary)]",
);

/**
 * Attributes of the selected row or tile: `aria-current` for assistive tech
 * (TanStack sets the same value itself when the row's link is the exact page;
 * this also covers an older thread, the bot's chats list and its editor), and
 * the hook the list uses to scroll it into view.
 */
export function selectedChatProps(
  selected: boolean,
): { "aria-current": "page"; "data-sidebar-selected": "" } | Record<string, never> {
  return selected ? { "aria-current": "page", "data-sidebar-selected": "" } : {};
}

/**
 * First non-empty line of the newest user/assistant message, else the thread
 * title. A turn the task service wrote previews as its system-row text. The
 * message comes with `personalBots.list`, so the list opens no thread
 * subscription per row; the list refreshes when a thread's shell updates.
 */
export function previewOf(summary: BotSummary, describeTurn: (turn: ServerTurn) => string): string {
  const thread = summary.newestThread;
  if (thread === null) return "No chats yet";
  const message = summary.newestMessage;
  if (message !== null) {
    const turn = readServerTurn(message);
    if (turn !== null) return describeTurn(turn);
    const line = message.text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (line) return line;
  }
  return thread.title;
}

/**
 * The part of {@link previewOf} that may be written to disk: a turn label when
 * the newest message is a task-service turn, else null so the cold-start
 * snapshot falls back to the thread title. The raw message line is never
 * returned — see the invariant in `chatsSnapshot.ts`.
 */
export function snapshotPreviewLabel(
  summary: BotSummary,
  describeTurn: (turn: ServerTurn) => string,
): string | null {
  if (summary.newestThread === null || summary.newestMessage === null) return null;
  const turn = readServerTurn(summary.newestMessage);
  return turn === null ? null : describeTurn(turn);
}

/**
 * Chats list row (ui-spec Screen 1): 56px avatar, name + live dot,
 * relative timestamp, provider label and a one-line preview. Every value is
 * derived from real bot/thread state; there is no unread badge because T3
 * has no unread concept to back it.
 *
 * Tapping opens the bot's newest chat in the personal conversation view, or
 * starts its first one. A bot whose provider cannot run and has no chat yet
 * links to its editor instead, so the row is always actionable.
 */
export const BotRow = memo(function BotRow({
  environmentId,
  summary,
  now,
  describeTurn,
  motion,
  selected = false,
}: {
  environmentId: EnvironmentId;
  summary: BotSummary;
  now: number;
  describeTurn: (turn: ServerTurn) => string;
  /** Avatar pose for this row; the list decides which row may animate. */
  motion?: AvatarMotion | undefined;
  /** This bot's chat (or chats list, or editor) is open in the desktop pane. */
  selected?: boolean | undefined;
}): JSX.Element {
  const preview = previewOf(summary, describeTurn);
  const { bot, newestThread, provider, live, lastActivityMs } = summary;
  const status = botStatus(summary, now);
  const { start, starting } = useStartBotChat(environmentId, bot.botId);
  const rowClass = cn(ROW_CLASS, selected && SELECTED_ROW_CLASS);
  const selectedProps = selectedChatProps(selected);

  const content: ReactNode = (
    <>
      <BotAvatar
        shape={bot.avatarShape}
        color={bot.avatarColor}
        size={56}
        label={bot.name}
        motion={motion}
        // The list's single uncapped working row gets the comet too (the cap in
        // ChatsScreen keeps it to one per list); the owner found no lag on device.
        comet
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center">
          <span className="truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            {bot.name}
          </span>
          {live ? (
            <span className="ml-2 flex shrink-0 items-center">
              <span aria-hidden="true" className="size-2 rounded-full bg-[var(--personal-live)]" />
              <span className="sr-only">, working</span>
            </span>
          ) : null}
          {lastActivityMs !== null ? (
            <time
              dateTime={new Date(lastActivityMs).toISOString()}
              className="ml-auto shrink-0 pl-3 text-[13px] leading-[22px] text-[var(--personal-text-tertiary)]"
            >
              {formatRelativeTime(lastActivityMs, now)}
            </time>
          ) : null}
        </span>
        <span
          className={cn(
            "truncate text-sm leading-5",
            status.tone === "review"
              ? "text-[var(--personal-review-text)]"
              : "text-[var(--personal-text-secondary)]",
          )}
        >
          {status.label}
        </span>
        <span className="truncate text-sm leading-5 text-[var(--personal-text-preview)]">
          {preview}
        </span>
      </span>
    </>
  );

  if (!provider.available) {
    return (
      <Link
        to="/bots/$botId/edit"
        params={{ botId: bot.botId }}
        aria-label={`${bot.name}: provider unavailable, edit bot`}
        className={rowClass}
        {...selectedProps}
      >
        {content}
      </Link>
    );
  }

  if (newestThread !== null) {
    return (
      <Link
        to="/bots/$botId/$threadId"
        params={{ botId: bot.botId, threadId: newestThread.id }}
        className={rowClass}
        {...selectedProps}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={starting}
      aria-busy={starting}
      className={cn(rowClass, "cursor-pointer disabled:cursor-wait")}
      {...selectedProps}
    >
      {content}
    </button>
  );
});
