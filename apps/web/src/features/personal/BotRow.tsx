import type { JSX, ReactNode } from "react";
import { memo } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import type { AvatarMotion } from "./avatarMotion";
import { BotAvatar } from "./BotAvatar";
import { MutedBell } from "./BotMute";
import { botMuteState } from "./botMuteModel";
import { splitModelMarker } from "./botModelLabel";
import { botStatus, type BotSummary } from "./botSummaries";
import type { ServerTurn } from "./delegationModel";
import { formatRelativeTime } from "./relativeTime";
import { useNewChatPrompt } from "./useNewChatPrompt";
import { UnreadChatsBadge } from "./UnreadChatsBadge";

import {
  plainPreviewLine,
  previewOf,
  snapshotPreviewLabel,
} from "@hbots/personal-client/bots/botRowModel";

export { plainPreviewLine, previewOf, snapshotPreviewLabel };

/**
 * md+ (the desktop bot list) pads the row by 12px, and the list pulls itself
 * out by the same amount (`md:-mx-3` in ChatsScreen), so the content stays on
 * the header's edge while the selected fill gets room either side of it.
 */
export const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-[18px] py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)] personal-row-hover md:rounded-[var(--personal-radius-button)] md:px-3";

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
 * Chats list row (ui-spec Screen 1): 56px avatar, name + live dot,
 * relative timestamp, provider label and a one-line preview. Every value is
 * derived from real bot/thread state. Bots that show unread chats (team
 * leads, `showsUnreadChats`) carry a count badge on the status line.
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
  comet = false,
  selected = false,
}: {
  environmentId: EnvironmentId;
  summary: BotSummary;
  now: number;
  describeTurn: (turn: ServerTurn) => string;
  /** Avatar pose for this row (`motionForSummary`). */
  motion?: AvatarMotion | undefined;
  /** Draw the working comet; the list gives it to every working row (`cometRowIndexes`). */
  comet?: boolean | undefined;
  /** This bot's chat (or chats list, or editor) is open in the desktop pane. */
  selected?: boolean | undefined;
}): JSX.Element {
  const preview = previewOf(summary, describeTurn);
  const unreadChats = summary.unreadChats ?? 0;
  const { bot, newestThread, provider, live, lastActivityMs } = summary;
  const status = botStatus(summary, now);
  const newChat = useNewChatPrompt(environmentId, bot);
  const rowClass = cn(ROW_CLASS, selected && SELECTED_ROW_CLASS);
  const selectedProps = selectedChatProps(selected);

  // The same short form as the pinned tiles and the chat headers: "Sonnet 5.5 · H".
  const rowModelLabel = summary.modelShortLabel;
  const modelParts = splitModelMarker(rowModelLabel ?? "");
  const content: ReactNode = (
    <>
      <BotAvatar
        shape={bot.avatarShape}
        color={bot.avatarColor}
        size={56}
        label={bot.name}
        motion={motion}
        comet={comet}
        thought="row"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center">
          <span className="flex min-w-0 items-center">
            <span className="max-w-full shrink-0 truncate text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
              {bot.name}
            </span>
            {rowModelLabel !== null ? (
              // The marker (" · fallback", " · sched") stays whole and the model
              // name gives way first, so a narrow phone reads "Sonn… · fallback"
              // rather than "Sonnet 5.5 · fall…".
              <span
                data-testid="bot-model-label"
                className="ml-1.5 flex min-w-0 shrink-[100] text-[13px] leading-[22px] text-[var(--personal-text-tertiary)]"
              >
                <span className="min-w-0 truncate">{modelParts.base}</span>
                {modelParts.marker !== null ? (
                  <span data-testid="bot-model-marker" className="shrink-0 whitespace-pre">
                    {` · ${modelParts.marker}`}
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
          {botMuteState(bot, now).muted ? <MutedBell className="ml-1.5" /> : null}
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
            "flex min-w-0 items-center gap-1.5 text-sm leading-5",
            status.tone === "review"
              ? "text-[var(--personal-review-text)]"
              : "text-[var(--personal-text-secondary)]",
          )}
        >
          {status.tone === "waiting" ? (
            // A hollow ring, not the live dot: the bot is not working, it waits on a task.
            <span
              aria-hidden="true"
              data-testid="bot-waiting-ring"
              className="size-2 shrink-0 rounded-full border border-[var(--personal-text-tertiary)]"
            />
          ) : null}
          <span className="truncate">{status.label}</span>
          {unreadChats > 0 ? <UnreadChatsBadge count={unreadChats} className="ml-auto" /> : null}
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
    <>
      <button
        type="button"
        onClick={() => newChat.open()}
        disabled={newChat.starting}
        aria-busy={newChat.starting}
        className={cn(rowClass, "cursor-pointer disabled:cursor-wait")}
        {...selectedProps}
      >
        {content}
      </button>
      {newChat.dialog}
    </>
  );
});
