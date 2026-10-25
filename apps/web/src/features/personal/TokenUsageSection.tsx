import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import type {
  EnvironmentId,
  PersonalBot,
  PersonalBotTokenUsageResult,
  PersonalBotTokenUsageWindowId,
} from "@t3tools/contracts";
import { ChevronRight, Info, Laptop } from "lucide-react";

import { cn } from "~/lib/utils";
import { primaryServerProvidersAtom } from "~/state/server";

import { BotAvatar } from "./BotAvatar";
import { BotUsageSheet } from "./BotUsageSheet";
import { ProviderDot, ProviderMixBar } from "./ProviderMixBar";
import { formatRelativeTime } from "./relativeTime";
import { UsageRangeControl } from "./UsageRangeControl";
import { useUsageSheetRoute } from "./usageSheetRoute";
import { useMinuteNow } from "./useMinuteNow";
import { usePersonalTokenUsage } from "./usePersonalBots";
import {
  deepSeekSpendText,
  formatBalanceAmount,
  refreshFailureText,
  selectDeepSeekBalanceLine,
  type UsageBalanceLine,
} from "./usagePresentation";
import {
  barWidthPercent,
  buildTokenUsageTable,
  DEFAULT_TOKEN_USAGE_WINDOW,
  findTokenUsageWindow,
  formatCostCompact,
  formatIdleBots,
  formatModelsAndShare,
  formatShare,
  formatSplit,
  formatTokenCount,
  formatUpdated,
  formatWindowSpan,
  isTokenUsagePending,
  splitOf,
  TOKEN_USAGE_MAX_POLLS,
  TOKEN_USAGE_POLL_MS,
  tokenUsageBotButtonLabel,
  tokenUsageProviderLabel,
  type TokenUsageRowView,
  type TokenUsageTable,
} from "./tokenUsagePresentation";

/**
 * Token usage on the Team screen, under the team diagram: the total, who it
 * belongs to by provider, and one row per bot, heaviest first. A bot row opens
 * that bot's sheet (BotUsageSheet) with every model in full; the sheet is
 * driven by `?usage=<botId>` so Back closes it and stays on Team.
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
  modelNames,
}: {
  readonly environmentId: EnvironmentId | null;
  /** Every bot the screen can open. */
  readonly bots: ReadonlyArray<PersonalBot>;
  /** The bots shown in the team diagram: they get a row even with no use. */
  readonly listedBotIds: ReadonlySet<string>;
  /** Model slug to the name the picker shows, for the per-model lines. */
  readonly modelNames: ReadonlyMap<string, string>;
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

  const sheet = useUsageSheetRoute();

  return (
    <TokenUsageCard
      openBotId={sheet.openBotId}
      onOpenBot={sheet.open}
      onCloseBot={sheet.close}
      onOpenChat={sheet.openChat}
      result={usage.data}
      error={usage.error}
      onRetry={() => {
        restartPolling();
        usage.refresh();
      }}
      bots={bots}
      listedBotIds={listedBotIds}
      modelNames={modelNames}
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
  modelNames,
  nowMs,
  balanceLine = null,
  openBotId = null,
  onOpenBot = NO_OP,
  onCloseBot = NO_OP,
  onOpenChat = NO_OP,
}: {
  readonly result: PersonalBotTokenUsageResult | null;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly bots: ReadonlyArray<PersonalBot>;
  readonly listedBotIds: ReadonlySet<string>;
  readonly modelNames: ReadonlyMap<string, string>;
  readonly nowMs: number;
  /** The DeepSeek prepaid balance, when there is a reading to show. */
  readonly balanceLine?: UsageBalanceLine | null;
  /** The bot whose sheet is open (`?usage=<botId>`), if any. */
  readonly openBotId?: string | null;
  /** A bot row was tapped. */
  readonly onOpenBot?: (botId: string) => void;
  /** The sheet was dismissed by any route (Back, swipe, ×, scrim, Esc). */
  readonly onCloseBot?: () => void;
  /** "Open chat" in the sheet. */
  readonly onOpenChat?: (botId: string) => void;
}): JSX.Element {
  // One range for the card and the sheet: both draw from this state.
  const [windowId, setWindowId] = useState<PersonalBotTokenUsageWindowId>(
    DEFAULT_TOKEN_USAGE_WINDOW,
  );
  const [noteOpen, setNoteOpen] = useState(false);
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
            modelNames,
          }),
    [bots, listedBotIds, modelNames, selected],
  );
  const updated = formatUpdated(result?.readAt ?? null, nowMs);
  const refreshing = result?.status === "refreshing";
  const counting = result?.status === "warming";
  const sheetBot = openBotId === null ? null : (botById.get(openBotId) ?? null);
  const sheetRow =
    openBotId === null || table === null
      ? null
      : (table.rows.find((row) => row.botId === openBotId) ?? null);
  const periodWord = windowId === "today" ? "today" : "in this period";

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
          <span
            data-testid="token-usage-span"
            className="shrink-0 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]"
          >
            {formatWindowSpan(table.sinceDay, table.untilDay)}
          </span>
        )}
      </div>

      <UsageRangeControl windowId={windowId} onChange={setWindowId} />

      {table !== null ? (
        table.total === 0 ? (
          <>
            <div className="flex items-end justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span
                  data-testid="token-usage-total"
                  className="text-[32px] leading-9 font-bold tracking-[-0.02em] text-[var(--personal-text)] tabular-nums"
                >
                  0
                </span>
                <span className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                  tokens {periodWord}
                </span>
              </div>
            </div>
            <p className="text-[15px] leading-5 text-[var(--personal-text-secondary)]">
              No bot used tokens {periodWord}.
              {windowId === "today" ? " Pick 7 days or 30 days to see recent use." : ""}
            </p>
          </>
        ) : (
          <>
            <UsageHero
              table={table}
              noteOpen={noteOpen}
              onToggleNote={() => setNoteOpen((open) => !open)}
            />
            <ProviderMix table={table} />
            <div className="border-t border-[var(--personal-border)]" />
            <h3 className="flex items-baseline justify-between gap-3 text-[13px] leading-[18px] font-medium text-[var(--personal-text-secondary)]">
              <span>By bot</span>
              <span>tap a bot for its models</span>
            </h3>
            <BotRows table={table} botById={botById} onOpenBot={onOpenBot} openBotId={openBotId} />
            {table.idleBotNames.length === 0 ? null : (
              <p
                data-testid="token-usage-idle"
                className="text-[12px] leading-4 text-[var(--personal-text-tertiary)]"
              >
                {formatIdleBots(table.idleBotNames)}
              </p>
            )}
            <div className="flex flex-col gap-2.5 border-t border-[var(--personal-border)] pt-3">
              {selected === null ? null : (
                <p
                  data-testid="token-usage-split"
                  className="text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums"
                >
                  {formatSplit(splitOf(selected.total.totals))}
                </p>
              )}
            </div>
          </>
        )
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
        <UsageSkeleton counting={counting} />
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

      <BotUsageSheet
        open={openBotId !== null}
        bot={sheetBot}
        row={sheetRow}
        table={table}
        windowId={windowId}
        onWindowChange={setWindowId}
        onClose={onCloseBot}
        onOpenChat={onOpenChat}
      />
    </section>
  );
}

function NO_OP(): void {}

/** The total, its API estimate (tap for what that means), and the note. */
function UsageHero({
  table,
  noteOpen,
  onToggleNote,
}: {
  readonly table: TokenUsageTable;
  readonly noteOpen: boolean;
  readonly onToggleNote: () => void;
}): JSX.Element {
  const cost = formatCostCompact(table.totalCost);
  return (
    <>
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span
            data-testid="token-usage-total"
            className="text-[32px] leading-9 font-bold tracking-[-0.02em] text-[var(--personal-text)] tabular-nums"
          >
            {formatTokenCount(table.total)}
          </span>
          <span className="text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            tokens, all providers
          </span>
        </div>
        {cost === "" ? null : (
          <button
            type="button"
            aria-expanded={noteOpen}
            aria-controls="usage-price-note"
            onClick={onToggleNote}
            className="flex min-h-11 shrink-0 flex-col items-end justify-center rounded-[10px] px-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <span
              data-testid="token-usage-total-cost"
              className="text-[20px] leading-6 font-semibold text-[var(--personal-text)] tabular-nums"
            >
              {cost}
            </span>
            <span className="flex items-center gap-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
              API estimate
              <Info aria-hidden="true" className="size-3.5" strokeWidth={2} />
            </span>
          </button>
        )}
      </div>
      {noteOpen ? (
        <p
          id="usage-price-note"
          data-testid="token-usage-price-note"
          className="rounded-lg bg-[var(--personal-fill-muted)] px-2.5 py-2 text-[12px] leading-4 text-[var(--personal-text-secondary)]"
        >
          What these tokens would cost at list API prices. Not money charged: subscriptions are
          flat. + means some tokens have no price.
        </p>
      ) : null}
    </>
  );
}

/** The provider bar over everything counted, and its legend: one cell per provider. */
function ProviderMix({ table }: { readonly table: TokenUsageTable }): JSX.Element | null {
  if (table.providers.length === 0) return null;
  return (
    <>
      <ProviderMixBar
        segments={table.providers.map((entry) => ({
          provider: entry.provider,
          tokens: entry.tokens,
        }))}
        heightClass="h-2.5"
        testId="token-usage-provider-bar"
      />
      <ul data-testid="token-usage-providers" className="grid grid-cols-2 gap-x-5 gap-y-1.5">
        {table.providers.map((entry) => (
          <li
            key={entry.provider}
            role="group"
            aria-label={tokenUsageProviderLabel(entry)}
            data-provider-usage-row={entry.provider}
            className="flex min-h-11 min-w-0 flex-col justify-center"
          >
            <span aria-hidden="true" className="flex items-center gap-1.5">
              <ProviderDot provider={entry.provider} />
              <span className="min-w-0 truncate text-[14px] leading-5 font-semibold text-[var(--personal-text)]">
                {entry.label}
              </span>
              <span className="ml-auto shrink-0 text-[14px] leading-5 font-semibold text-[var(--personal-text)] tabular-nums">
                {formatTokenCount(entry.tokens)}
              </span>
            </span>
            <span
              aria-hidden="true"
              data-testid="token-usage-provider-cost"
              className="pl-3.5 text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums"
            >
              {[formatShare(entry.sharePercent), formatCostCompact(entry.cost)]
                .filter((part) => part !== "")
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Bots with use (each opens its sheet), then Outside Bots. Idle bots are one line below. */
function BotRows({
  table,
  botById,
  onOpenBot,
  openBotId,
}: {
  readonly table: TokenUsageTable;
  readonly botById: ReadonlyMap<string, PersonalBot>;
  readonly onOpenBot: (botId: string) => void;
  readonly openBotId: string | null;
}): JSX.Element {
  const used = table.rows.filter((row) => row.tokens > 0);
  const topTokens = used[0]?.tokens ?? 0;
  return (
    <ul className="-mx-2 flex flex-col">
      {used.map((row) => {
        const bot = botById.get(row.botId);
        if (bot === undefined) return null;
        return (
          <li key={row.botId}>
            <TokenUsageRow
              row={row}
              bot={bot}
              topTokens={topTokens}
              expanded={openBotId === row.botId}
              onOpen={onOpenBot}
            />
          </li>
        );
      })}
      {table.other.tokens > 0 ? (
        <li>
          <OutsideBotsRow table={table} topTokens={topTokens} />
        </li>
      ) : null}
    </ul>
  );
}

const ROW_GRID =
  "grid min-h-16 w-full grid-cols-[40px_1fr_16px] items-center gap-x-2.5 rounded-[10px] p-2 text-left";

function TokenUsageRow({
  row,
  bot,
  topTokens,
  expanded,
  onOpen,
}: {
  readonly row: TokenUsageRowView;
  readonly bot: PersonalBot;
  readonly topTokens: number;
  readonly expanded: boolean;
  readonly onOpen: (botId: string) => void;
}): JSX.Element {
  const cost = formatCostCompact(row.cost);
  return (
    <button
      type="button"
      onClick={() => onOpen(bot.botId)}
      aria-label={tokenUsageBotButtonLabel(row)}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      data-bot-usage-row={bot.botId}
      className={cn(
        ROW_GRID,
        "outline-none active:bg-[var(--personal-fill-muted)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
      )}
    >
      <span aria-hidden="true" className="relative grid size-10 place-items-center">
        <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={32} label="" />
        {row.rank === null ? null : (
          <span
            data-testid="token-usage-rank"
            className="absolute top-[-2px] left-[-2px] grid size-[18px] place-items-center rounded-full bg-[var(--personal-primary)] text-[11px] leading-none font-bold text-[var(--personal-primary-text)] ring-2 ring-[var(--personal-surface)]"
          >
            {row.rank}
          </span>
        )}
      </span>
      <span aria-hidden="true" className="flex min-w-0 flex-col gap-[5px]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
            {bot.name}
          </span>
          <span className="shrink-0 text-[16px] leading-5 font-semibold text-[var(--personal-text)] tabular-nums">
            {formatTokenCount(row.tokens)}
          </span>
        </span>
        <ProviderMixBar
          segments={row.mix}
          heightClass="h-1.5"
          widthPercent={barWidthPercent(row.tokens, topTokens)}
          testId="token-usage-bar"
        />
        <span className="flex items-baseline justify-between gap-2 text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums">
          <span data-testid="token-usage-row-meta">{formatModelsAndShare(row)}</span>
          {cost === "" ? null : (
            <span
              data-testid="token-usage-row-cost"
              className={cn(
                "shrink-0",
                row.cost.kind === "unpriced" ? "text-[var(--personal-text-tertiary)]" : "",
              )}
            >
              {cost}
            </span>
          )}
        </span>
      </span>
      <ChevronRight
        aria-hidden="true"
        className="size-4 text-[var(--personal-text-tertiary)]"
        strokeWidth={2}
      />
    </button>
  );
}

/** Sessions no bot owns. Not tappable: there is no bot to open. */
function OutsideBotsRow({
  table,
  topTokens,
}: {
  readonly table: TokenUsageTable;
  readonly topTokens: number;
}): JSX.Element {
  const cost = formatCostCompact(table.other.cost);
  return (
    <div className={ROW_GRID} data-testid="token-usage-outside-row">
      <span aria-hidden="true" className="grid size-10 place-items-center">
        <span className="grid size-8 place-items-center rounded-full bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]">
          <Laptop className="size-[18px]" strokeWidth={1.8} />
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-[5px]">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
            Outside Bots
          </span>
          <span
            data-testid="token-usage-outside"
            className="shrink-0 text-[16px] leading-5 font-semibold text-[var(--personal-text)] tabular-nums"
          >
            {formatTokenCount(table.other.tokens)}
          </span>
        </span>
        <ProviderMixBar
          segments={table.other.mix}
          heightClass="h-1.5"
          widthPercent={barWidthPercent(
            table.other.tokens,
            Math.max(topTokens, table.other.tokens),
          )}
          testId="token-usage-outside-bar"
        />
        <span className="flex items-baseline justify-between gap-2 text-[12px] leading-4 text-[var(--personal-text-secondary)] tabular-nums">
          <span className="min-w-0">your own Claude Code and older sessions</span>
          {cost === "" ? null : (
            <span
              data-testid="token-usage-outside-cost"
              className={cn(
                "shrink-0",
                table.other.cost.kind === "unpriced" ? "text-[var(--personal-text-tertiary)]" : "",
              )}
            >
              {cost}
            </span>
          )}
        </span>
      </span>
      <span />
    </div>
  );
}

/** While the first count lands: the card's shape in grey, so nothing jumps when it arrives. */
function UsageSkeleton({ counting }: { readonly counting: boolean }): JSX.Element {
  const block = "animate-pulse rounded-md bg-[var(--personal-fill-muted)]";
  return (
    <>
      <div aria-hidden="true" className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className={cn(block, "h-[34px] w-[120px]")} />
          <div className={cn(block, "h-3 w-[90px]")} />
        </div>
        <div className={cn(block, "h-6 w-20")} />
      </div>
      <div aria-hidden="true" className={cn(block, "h-2.5")} />
      <p role="status" className="text-[12px] leading-4 text-[var(--personal-text-secondary)]">
        {counting
          ? "Counting tokens. The first count after a restart takes up to a minute."
          : "Loading token usage…"}
      </p>
      {[0, 1, 2].map((index) => (
        <div key={index} aria-hidden="true" className="flex min-h-16 items-center gap-3 px-0">
          <div className={cn(block, "size-8 shrink-0 rounded-full")} />
          <div className="flex flex-1 flex-col gap-[7px]">
            <div className={cn(block, "h-3.5 w-3/5")} />
            <div className={cn(block, "h-1.5 w-[85%]")} />
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * DeepSeek's prepaid balance under the totals: these tokens are billed against
 * it, unlike the flat subscriptions the price estimate above cannot charge.
 * One quiet row, hidden entirely when there is no reading; the failure note
 * rides it when the newest read failed and the numbers are the last good ones.
 * The spent line is our own records' value at DeepSeek's published Flash
 * rates, in the same words as the usage sheet card.
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
  const spentText = deepSeekSpendText(balance.spent, nowMs);
  return (
    <div
      data-testid="token-usage-balance"
      className="flex items-baseline justify-between gap-3 border-t border-[var(--personal-border)] pt-3 text-[14px] leading-5 text-[var(--personal-text-secondary)]"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">DeepSeek balance</span>
        <span
          data-testid="token-usage-balance-spent"
          className={cn(
            "truncate text-[12px] leading-4 tabular-nums",
            balance.spent === null
              ? "text-[var(--personal-text-tertiary)]"
              : "text-[var(--personal-text-secondary)]",
          )}
        >
          {spentText}
        </span>
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
