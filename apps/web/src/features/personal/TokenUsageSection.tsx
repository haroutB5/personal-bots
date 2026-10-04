import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  EnvironmentId,
  PersonalBot,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageWindowId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";

import { BotAvatar } from "./BotAvatar";
import { useMinuteNow } from "./useMinuteNow";
import { usePersonalTokenUsage } from "./usePersonalBots";
import {
  buildTokenUsageTable,
  DEFAULT_TOKEN_USAGE_WINDOW,
  findTokenUsageWindow,
  formatShare,
  formatSplit,
  formatTokenCount,
  formatUpdated,
  formatWindowRange,
  isTokenUsagePending,
  splitOf,
  TOKEN_USAGE_MAX_POLLS,
  TOKEN_USAGE_POLL_MS,
  TOKEN_USAGE_WINDOWS,
  tokenUsageRowLabel,
  type TokenUsageRowView,
} from "./tokenUsagePresentation";

/**
 * Token usage per bot, under the team diagram: who used how many tokens over
 * Today, 7 days or 30 days, heaviest first. The three heaviest carry a rank
 * chip and a strong bar, so the top is plain without colour. A tap opens the
 * bot, the same link the diagram's nodes use, so Back lands on this screen.
 */
export function TokenUsageSection({
  environmentId,
  bots,
  listedBotIds,
  modelLabels,
}: {
  readonly environmentId: EnvironmentId | null;
  /** Every bot the screen can open. */
  readonly bots: ReadonlyArray<PersonalBot>;
  /** The bots shown in the team diagram: they get a row even with no use. */
  readonly listedBotIds: ReadonlySet<string>;
  readonly modelLabels: ReadonlyMap<string, string | null>;
}): JSX.Element {
  const usage = usePersonalTokenUsage(environmentId);
  const nowMs = useMinuteNow();
  const status = usage.data?.status;

  // Ask again soon while the server is still counting (the first count after a
  // restart, or a stale snapshot being refreshed), then leave it to the
  // ten-minute refresh.
  const pollsRef = useRef(0);
  const refreshRef = useRef(usage.refresh);
  useEffect(() => {
    refreshRef.current = usage.refresh;
  });
  useEffect(() => {
    if (!isTokenUsagePending(status)) {
      pollsRef.current = 0;
      return;
    }
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (pollsRef.current >= TOKEN_USAGE_MAX_POLLS) {
        window.clearInterval(timer);
        return;
      }
      pollsRef.current += 1;
      refreshRef.current();
    }, TOKEN_USAGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [status]);

  return (
    <TokenUsageCard
      result={usage.data}
      error={usage.error}
      onRetry={() => {
        pollsRef.current = 0;
        usage.refresh();
      }}
      bots={bots}
      listedBotIds={listedBotIds}
      modelLabels={modelLabels}
      nowMs={nowMs}
    />
  );
}

/** The card itself: everything it shows comes from its props. */
export function TokenUsageCard({
  result,
  error,
  onRetry,
  bots,
  listedBotIds,
  modelLabels,
  nowMs,
}: {
  readonly result: PersonalBotTokenUsageResult | null;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly listedBotIds: ReadonlySet<string>;
  readonly modelLabels: ReadonlyMap<string, string | null>;
  readonly nowMs: number;
}): JSX.Element {
  const [windowId, setWindowId] = useState<PersonalBotTokenUsageWindowId>(
    DEFAULT_TOKEN_USAGE_WINDOW,
  );
  const selected = findTokenUsageWindow(result, windowId);
  const botById = useMemo(() => new Map(bots.map((bot) => [bot.botId as string, bot])), [bots]);
  const table = useMemo(
    () =>
      selected === null
        ? null
        : buildTokenUsageTable({
            window: selected,
            bots: bots.map((bot) => ({ botId: bot.botId, name: bot.name })),
            listedBotIds,
          }),
    [bots, listedBotIds, selected],
  );
  const updated = formatUpdated(result?.readAt ?? null, nowMs);
  const refreshing = result?.status === "refreshing";
  const counting = result?.status === "warming";

  return (
    <section
      aria-label="Token usage"
      aria-busy={counting || refreshing}
      data-testid="token-usage"
      className="mt-5 flex flex-col gap-3 overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4 shadow-[var(--personal-shadow-card)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[16px] leading-6 font-semibold text-[var(--personal-text)]">
          Token usage
        </h2>
        {table === null ? null : (
          <span className="shrink-0 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            {formatWindowRange(table.sinceDay, table.untilDay)}
          </span>
        )}
      </div>

      <div
        role="radiogroup"
        aria-label="Time range"
        className="grid grid-cols-3 gap-1 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] p-1"
      >
        {TOKEN_USAGE_WINDOWS.map((option) => {
          const on = option.id === windowId;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setWindowId(option.id)}
              className={cn(
                "min-h-11 rounded-[8px] px-2 text-[15px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
                on
                  ? "bg-[var(--personal-primary)] font-semibold text-[var(--personal-primary-text)]"
                  : "font-medium text-[var(--personal-text-secondary)]",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {table !== null ? (
        <>
          {table.botsTotal === 0 ? (
            <p className="py-1 text-[15px] leading-snug text-[var(--personal-text-secondary)]">
              No bot used tokens {windowId === "today" ? "today" : "in this period"}.
            </p>
          ) : null}
          <ul className="-mx-1 flex flex-col">
            {table.rows.map((row) => {
              const bot = botById.get(row.botId);
              if (bot === undefined) return null;
              return (
                <li key={row.botId}>
                  <TokenUsageRow
                    row={row}
                    bot={bot}
                    modelLabel={modelLabels.get(row.botId) ?? null}
                  />
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col gap-1.5 border-t border-[var(--personal-border)] pt-3">
            <div className="flex items-baseline justify-between gap-3 text-[14px] leading-5 text-[var(--personal-text-secondary)]">
              <span className="flex min-w-0 flex-col">
                <span className="truncate">Outside Bots</span>
                <span className="truncate text-[12px] leading-4 text-[var(--personal-text-tertiary)]">
                  your own Claude Code and older sessions
                </span>
              </span>
              <span className="shrink-0 tabular-nums" data-testid="token-usage-outside">
                {formatTokenCount(table.other.tokens)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3 text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
              <span>Total</span>
              <span className="tabular-nums" data-testid="token-usage-total">
                {formatTokenCount(table.total)}
              </span>
            </div>
            {selected === null ? null : (
              <p className="text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums">
                {formatSplit(splitOf(selected.total.totals))}
              </p>
            )}
          </div>
        </>
      ) : error !== null ? (
        <div role="alert" className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-[15px] leading-snug text-[var(--personal-text)]">
            Couldn&apos;t load token usage.
          </p>
          <RetryButton onRetry={onRetry} />
        </div>
      ) : result?.status === "unavailable" ? (
        <div role="alert" className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-[15px] leading-snug text-[var(--personal-text)]">
            Couldn&apos;t count tokens just now.
          </p>
          <RetryButton onRetry={onRetry} />
        </div>
      ) : (
        <p
          role="status"
          className="py-1 text-[15px] leading-snug text-[var(--personal-text-secondary)]"
        >
          {counting
            ? "Counting tokens. The first count after a restart takes up to a minute."
            : "Loading token usage…"}
        </p>
      )}

      {table !== null && (updated !== null || refreshing) ? (
        <p
          role="status"
          className="text-[12px] leading-4 text-[var(--personal-text-secondary)]"
          data-testid="token-usage-updated"
        >
          {[updated, refreshing ? "Updating…" : null].filter(Boolean).join(" · ")}
        </p>
      ) : null}
    </section>
  );
}

function RetryButton({ onRetry }: { readonly onRetry: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="h-11 shrink-0 rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-medium text-[var(--personal-text)]"
    >
      Try again
    </button>
  );
}

function TokenUsageRow({
  row,
  bot,
  modelLabel,
}: {
  readonly row: TokenUsageRowView;
  readonly bot: PersonalBot;
  readonly modelLabel: string | null;
}): JSX.Element {
  const top = row.rank !== null;
  const barPercent = row.tokens === 0 ? 0 : Math.max(1.5, Math.min(100, row.sharePercent));
  return (
    <Link
      to="/bots/$botId"
      params={{ botId: bot.botId }}
      aria-label={tokenUsageRowLabel(row)}
      data-bot-usage-row={bot.botId}
      className="flex min-h-[60px] items-center gap-3 rounded-[10px] px-1 py-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
    >
      <span aria-hidden="true" className="relative shrink-0">
        <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={32} label="" />
        {row.rank === null ? null : (
          <span
            data-testid="token-usage-rank"
            className="absolute -top-1.5 -left-1.5 grid size-[18px] place-items-center rounded-full bg-[var(--personal-primary)] text-[11px] leading-none font-bold text-[var(--personal-primary-text)] ring-2 ring-[var(--personal-surface)]"
          >
            {row.rank}
          </span>
        )}
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col gap-1.25">
        <span className="flex min-w-0 items-baseline">
          <span className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
            {bot.name}
          </span>
          {modelLabel === null ? null : (
            // Gives way before the name does: it shrinks first and truncates.
            <span className="ml-1.5 min-w-0 shrink-[100] truncate text-[12px] leading-5 text-[var(--personal-text-tertiary)]">
              {modelLabel}
            </span>
          )}
        </span>
        <span className="block h-[3px] overflow-hidden rounded-full bg-[var(--personal-track)]">
          <span
            data-testid="token-usage-bar"
            className={cn(
              "block h-full rounded-full",
              top ? "bg-[var(--personal-primary)]" : "bg-[var(--personal-text-tertiary)]",
            )}
            style={{ width: `${barPercent}%` }}
          />
        </span>
        <span className="truncate text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums">
          {row.tokens === 0 ? "No use in this period" : formatSplit(row.split)}
        </span>
      </span>
      <span aria-hidden="true" className="flex w-[64px] shrink-0 flex-col items-end">
        <span
          className={cn(
            "text-[16px] leading-5 tabular-nums",
            row.tokens === 0
              ? "font-medium text-[var(--personal-text-tertiary)]"
              : "font-semibold text-[var(--personal-text)]",
          )}
        >
          {formatTokenCount(row.tokens)}
        </span>
        <span className="text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums">
          {formatShare(row.sharePercent)}
        </span>
      </span>
    </Link>
  );
}
