import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import type {
  EnvironmentId,
  PersonalBot,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageWindowId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { primaryServerProvidersAtom } from "~/state/server";

import { BotAvatar } from "./BotAvatar";
import { formatRelativeTime } from "./relativeTime";
import { useMinuteNow } from "./useMinuteNow";
import { usePersonalTokenUsage } from "./usePersonalBots";
import {
  formatBalanceAmount,
  refreshFailureText,
  selectDeepSeekBalanceLine,
  type UsageBalanceLine,
} from "./usagePresentation";
import {
  buildTokenUsageTable,
  DEFAULT_TOKEN_USAGE_WINDOW,
  findTokenUsageWindow,
  formatCostCompact,
  formatCostFull,
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
  tokenUsageProviderLabel,
  tokenUsageRowLabel,
  type TokenCostView,
  type TokenUsageProviderView,
  type TokenUsageRowView,
} from "./tokenUsagePresentation";

/**
 * Token usage per bot, under the team diagram: who used how many tokens over
 * Today, 7 days or 30 days, heaviest first. The three heaviest carry a rank
 * chip and a strong bar, so the top is plain without colour. A tap opens the
 * bot, the same link the diagram's nodes use, so Back lands on this screen.
 */
/** The refresh while the card is open: what is shown is never older than this by much. */
export const TOKEN_USAGE_REFRESH_MS = 10 * 60_000;

const pageVisible = (): boolean =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Everything that re-asks the server for token usage, and nothing else does:
 * the query atom has no refresh timer of its own, because an atom's timer
 * outlives its subscriber for the whole idle retention (it asked, and so
 * started a scan, ten minutes after the card had gone). These timers belong to
 * the mounted card, so unmounting stops them, and they stand down while the
 * page is hidden.
 *
 * - every ten minutes, to keep the numbers current while the card is open;
 * - every few seconds while the server is still counting (`warming`, or a
 *   stale snapshot being refreshed), up to a bound;
 * - once when the page comes back from hidden with numbers older than ten
 *   minutes.
 */
export function useTokenUsageRefresh(input: {
  readonly status: PersonalBotTokenUsageResult["status"] | undefined;
  readonly dataUpdatedAt: number | null;
  readonly refresh: () => void;
}): { readonly restartPolling: () => void } {
  const { status } = input;
  const pollsRef = useRef(0);
  const refreshRef = useRef(input.refresh);
  const updatedRef = useRef(input.dataUpdatedAt);
  useEffect(() => {
    refreshRef.current = input.refresh;
    updatedRef.current = input.dataUpdatedAt;
  });
  const [visible, setVisible] = useState(pageVisible);

  useEffect(() => {
    const onChange = () => {
      const nowVisible = pageVisible();
      setVisible(nowVisible);
      if (!nowVisible) return;
      const updated = updatedRef.current;
      if (updated === null || Date.now() - updated >= TOKEN_USAGE_REFRESH_MS) refreshRef.current();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => refreshRef.current(), TOKEN_USAGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (!isTokenUsagePending(status)) {
      pollsRef.current = 0;
      return;
    }
    if (!visible) return;
    const timer = window.setInterval(() => {
      if (pollsRef.current >= TOKEN_USAGE_MAX_POLLS) {
        window.clearInterval(timer);
        return;
      }
      pollsRef.current += 1;
      refreshRef.current();
    }, TOKEN_USAGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, visible]);

  return {
    restartPolling: () => {
      pollsRef.current = 0;
    },
  };
}

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

  const { restartPolling } = useTokenUsageRefresh({
    status,
    dataUpdatedAt: usage.dataUpdatedAt,
    refresh: usage.refresh,
  });
  // DeepSeek's prepaid balance, from the provider snapshot the app already
  // streams: the same figure the usage sheet's DeepSeek card shows, so the two
  // never disagree.
  const providers = useAtomValue(primaryServerProvidersAtom);
  const balanceLine = useMemo(
    () => selectDeepSeekBalanceLine(providers, nowMs),
    [providers, nowMs],
  );

  return (
    <TokenUsageCard
      result={usage.data}
      error={usage.error}
      onRetry={() => {
        restartPolling();
        usage.refresh();
      }}
      bots={bots}
      listedBotIds={listedBotIds}
      modelLabels={modelLabels}
      nowMs={nowMs}
      balanceLine={balanceLine}
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
  balanceLine = null,
}: {
  readonly result: PersonalBotTokenUsageResult | null;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly listedBotIds: ReadonlySet<string>;
  readonly modelLabels: ReadonlyMap<string, string | null>;
  readonly nowMs: number;
  /** The DeepSeek prepaid balance, when there is a reading to show. */
  readonly balanceLine?: UsageBalanceLine | null;
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
          {table.providers.length > 0 ? (
            <div
              data-testid="token-usage-providers"
              className="flex flex-col gap-1 border-b border-[var(--personal-border)] pb-3"
            >
              <h3 className="text-[13px] leading-[18px] font-medium text-[var(--personal-text-secondary)]">
                By provider
              </h3>
              <ul className="flex flex-col">
                {table.providers.map((provider) => (
                  <li key={provider.provider}>
                    <TokenUsageProviderRow row={provider} />
                  </li>
                ))}
              </ul>
              <div
                data-testid="token-usage-providers-total"
                className="flex flex-col gap-0.5 border-t border-[var(--personal-border)] pt-2"
              >
                <span className="flex items-baseline justify-between gap-3 text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
                  <span>All providers</span>
                  <span className="tabular-nums">{formatTokenCount(table.total)}</span>
                </span>
                <span
                  data-testid="token-usage-providers-total-cost"
                  className="text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums"
                >
                  {formatCostFull(table.totalCost)}
                </span>
              </div>
              <p
                data-testid="token-usage-price-note"
                className="text-[12px] leading-4 text-[var(--personal-text-secondary)]"
              >
                API price estimate: what these tokens would cost at list API prices, not money
                charged (subscriptions are flat). + means some tokens have no price.
              </p>
            </div>
          ) : null}
          {table.providers.length > 0 ? (
            <h3 className="-mb-1 text-[13px] leading-[18px] font-medium text-[var(--personal-text-secondary)]">
              By bot
            </h3>
          ) : null}
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
              <span className="flex shrink-0 flex-col items-end tabular-nums">
                <span data-testid="token-usage-outside">
                  {formatTokenCount(table.other.tokens)}
                </span>
                <CostLine cost={table.other.cost} testId="token-usage-outside-cost" />
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3 text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
              <span>Total</span>
              <span className="flex flex-col items-end tabular-nums">
                <span data-testid="token-usage-total">{formatTokenCount(table.total)}</span>
                <CostLine cost={table.totalCost} testId="token-usage-total-cost" />
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

      {balanceLine !== null ? <DeepSeekBalanceRow line={balanceLine} nowMs={nowMs} /> : null}

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

/**
 * DeepSeek's prepaid balance under the totals: these tokens are billed against
 * it, unlike the flat subscriptions the price estimate above cannot charge.
 * One quiet row, hidden entirely when there is no reading; the failure note
 * rides it when the newest read failed and the numbers are the last good ones.
 */
function DeepSeekBalanceRow({
  line,
  nowMs,
}: {
  readonly line: UsageBalanceLine;
  readonly nowMs: number;
}): JSX.Element {
  const { balance } = line;
  const failure = refreshFailureText(line.failure);
  const fetchedAt = balance.fetchedAt;
  const sub = `granted ${formatBalanceAmount(balance.granted, balance.currency)} · topped up ${formatBalanceAmount(balance.toppedUp, balance.currency)}`;
  return (
    <div
      data-testid="token-usage-balance"
      className="flex items-baseline justify-between gap-3 border-t border-[var(--personal-border)] pt-3 text-[14px] leading-5 text-[var(--personal-text-secondary)]"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">DeepSeek balance</span>
        <span className="truncate text-[12px] leading-4 text-[var(--personal-text-tertiary)] tabular-nums">
          {sub}
        </span>
        {failure !== null ? (
          <span className="truncate text-[12px] leading-4 text-[var(--personal-review-text)]">
            {failure}
          </span>
        ) : null}
      </span>
      {/* The age sits under the figure, not in the sub-line: at 390 px the
          three parts together ran past the row and "Updated 4m" was clipped. */}
      <span className="flex shrink-0 flex-col items-end tabular-nums">
        <span className="text-[15px] font-semibold text-[var(--personal-text)]">
          {formatBalanceAmount(balance.total, balance.currency)}
        </span>
        {fetchedAt !== null ? (
          <span className="text-[12px] leading-4 text-[var(--personal-text-tertiary)]">
            {`Updated ${formatRelativeTime(fetchedAt, nowMs)}`}
          </span>
        ) : null}
      </span>
    </div>
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
        <CostLine cost={row.cost} testId="token-usage-row-cost" />
      </span>
    </Link>
  );
}

/** The estimate under a count, in the secondary colour; nothing when there is no cost to show. */
function CostLine({
  cost,
  testId,
}: {
  readonly cost: TokenCostView;
  readonly testId: string;
}): JSX.Element | null {
  const text = formatCostCompact(cost);
  if (text === "") return null;
  return (
    <span
      data-testid={testId}
      className={cn(
        "text-[12px] leading-4 tabular-nums",
        cost.kind === "unpriced"
          ? "text-[var(--personal-text-tertiary)]"
          : "text-[var(--personal-text-secondary)]",
      )}
    >
      {text}
    </span>
  );
}

/** One provider: name and tokens, a bar over everything counted, then the estimate and the share. */
function TokenUsageProviderRow({ row }: { readonly row: TokenUsageProviderView }): JSX.Element {
  const barPercent = Math.max(1.5, Math.min(100, row.sharePercent));
  return (
    <div
      role="group"
      aria-label={tokenUsageProviderLabel(row)}
      data-provider-usage-row={row.provider}
      className="flex min-h-11 flex-col justify-center gap-1 py-1.5"
    >
      <span aria-hidden="true" className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
          {row.label}
        </span>
        <span className="shrink-0 text-[16px] leading-5 font-semibold text-[var(--personal-text)] tabular-nums">
          {formatTokenCount(row.tokens)}
        </span>
      </span>
      <span
        aria-hidden="true"
        className="block h-[3px] overflow-hidden rounded-full bg-[var(--personal-track)]"
      >
        <span
          data-testid="token-usage-provider-bar"
          className="block h-full rounded-full bg-[var(--personal-primary)]"
          style={{ width: `${barPercent}%` }}
        />
      </span>
      <span
        aria-hidden="true"
        className="flex items-baseline justify-between gap-3 text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums"
      >
        <span data-testid="token-usage-provider-cost">{formatCostFull(row.cost)}</span>
        <span>{formatShare(row.sharePercent)}</span>
      </span>
    </div>
  );
}
