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

export const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-[18px] py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]";

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
}: {
  environmentId: EnvironmentId;
  summary: BotSummary;
  now: number;
  describeTurn: (turn: ServerTurn) => string;
  /** Avatar pose for this row; the list decides which row may animate. */
  motion?: AvatarMotion | undefined;
}): JSX.Element {
  const preview = previewOf(summary, describeTurn);
  const { bot, newestThread, provider, live, lastActivityMs } = summary;
  const status = botStatus(summary, now);
  const { start, starting } = useStartBotChat(environmentId, bot.botId);

  const content: ReactNode = (
    <>
      <BotAvatar
        shape={bot.avatarShape}
        color={bot.avatarColor}
        size={56}
        label={bot.name}
        motion={motion}
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
              ? "text-[var(--personal-review)]"
              : "text-[var(--personal-text-secondary)]",
          )}
        >
          {status.label}
        </span>
        <span className="truncate text-sm leading-5 text-[#3a3a3a]">{preview}</span>
      </span>
    </>
  );

  if (!provider.available) {
    return (
      <Link
        to="/bots/$botId/edit"
        params={{ botId: bot.botId }}
        aria-label={`${bot.name}: provider unavailable, edit bot`}
        className={ROW_CLASS}
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
        className={ROW_CLASS}
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
      className={cn(ROW_CLASS, "cursor-pointer disabled:cursor-wait")}
    >
      {content}
    </button>
  );
});
