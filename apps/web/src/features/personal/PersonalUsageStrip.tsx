import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { isLowProviderBalance } from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useRef, useState, type JSX } from "react";
import { RefreshCw, X } from "lucide-react";

import { DEEPSEEK_TOP_UP_URL } from "~/components/settings/providerApiKeys";
import { Sheet, SheetClose, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { ChunkLoadBoundary } from "~/lib/ChunkLoadBoundary";
import { cn } from "~/lib/utils";
import { primaryServerProvidersAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { formatRelativeTime } from "./relativeTime";
import { trackUsageRefresh, useUsageRefreshing } from "./usageRefresh";
import {
  useHiddenUsageProviders,
  usePersonalEnvironmentId,
  usePersonalTokenUsage,
} from "./usePersonalBots";
import {
  deepSeekSpendText,
  formatBalanceAmount,
  selectOpenCodeSpendLine,
  selectUsageCards,
  usageCardEmptyText,
  usageAutoProbeDue,
  usageNeedsRefreshOnOpen,
  usageRefreshFailureText,
  usageSheetDescription,
  type UsageBalanceView,
  type UsageCard,
  type UsageWindowRow,
} from "./usagePresentation";
import {
  formatStripPercent,
  selectUsageStripCells,
  stripBindingWindow,
  stripCellBarPercent,
  stripShortWindow,
  usageStripAriaLabel,
  type UsageStripCell,
} from "./usageStrip";

import { providerColor } from "./tokenUsagePresentation";
import { useSheetDragDismiss } from "./useSheetDragDismiss";

/** The token-usage provider a limits card belongs to, so its dot matches the Team card's. */
function usageProviderOfDriver(driver: UsageCard["driver"]): UsageProviderKind {
  return driver === "claudeAgent" ? "claude" : driver;
}

// Upstream's reset-credit module brings the whole Limits tab with it; load it
// only once a sheet shows a banked credit.
const PersonalResetCredits = lazy(() => import("./PersonalResetCredits"));

/**
 * What this page has done about the first usage reading (see
 * `usageAutoProbeDue`). Module state, so leaving the list and coming back does
 * not count as a first load or start another probe.
 */
const autoProbe: { lastProbeAt: number | null; firstLoadSeen: boolean } = {
  lastProbeAt: null,
  firstLoadSeen: false,
};

/** Test hook: forget what this page has already asked for. */
export function resetUsageAutoProbe(): void {
  autoProbe.lastProbeAt = null;
  autoProbe.firstLoadSeen = false;
}

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-[var(--personal-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

/** Bars turn amber once a window is nearly spent; muted ink the rest of the time. */
function barColor(usedPercent: number): string {
  return usedPercent >= 80 ? "var(--personal-review)" : "var(--personal-text-tertiary)";
}

/**
 * The bar fills to the worse window, so it says how little headroom is left but
 * not which limit is doing it - and a spent 5-hour window clears in hours where
 * a spent week may not clear for days. Ink the binding one to name it.
 */
function bindingInk(cell: UsageStripCell, window: "session" | "weekly"): string {
  return stripBindingWindow(cell) === window ? "text-[var(--personal-review-text)]" : "";
}

/** A narrow desktop cell's figure: just the window its bar is filled to. */
function ShortWindowFigure({ cell }: { readonly cell: UsageStripCell }): JSX.Element {
  const window = stripShortWindow(cell);
  const nothing = cell.sessionPercent === null && cell.weeklyPercent === null;
  const percent = window === "session" ? cell.sessionPercent : cell.weeklyPercent;
  return (
    <span className={cn("hidden md:inline md:@min-[180px]:hidden", bindingInk(cell, window))}>
      {nothing
        ? "Not reported"
        : `${window === "session" ? "Sess" : "Wk"} ${formatStripPercent(percent)}`}
    </span>
  );
}

function StripCellBar({ percent }: { readonly percent: number | null }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="block h-[3px] overflow-hidden rounded-full bg-[var(--personal-track)]"
    >
      {percent !== null && percent > 0 ? (
        <span
          className="block h-full rounded-full"
          style={{ width: `${percent}%`, backgroundColor: barColor(percent) }}
        />
      ) : null}
    </span>
  );
}

function WindowRow({ card, row }: { readonly card: UsageCard; readonly row: UsageWindowRow }) {
  const summary = `${card.title} ${row.label}: ${row.usedPercent}% used${row.resetLabel ? `, ${row.resetLabel}` : ""}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[15px] text-[var(--personal-text)]">{row.label}</span>
        <span className="shrink-0 text-[15px] font-semibold text-[var(--personal-text)] tabular-nums">
          {`${row.usedPercent}% used`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={summary}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={row.usedPercent}
        className="h-2.5 overflow-hidden rounded-full bg-[var(--personal-track)]"
      >
        {row.usedPercent > 0 ? (
          <div
            className="h-full rounded-full"
            style={{
              width: `${row.usedPercent}%`,
              backgroundColor:
                row.usedPercent >= 80 ? "var(--personal-review)" : "var(--personal-text)",
            }}
          />
        ) : null}
      </div>
      <span className="text-[13px] text-[var(--personal-text-secondary)] tabular-nums">
        {row.resetTimeLabel ?? "Reset time not reported"}
        {row.resetTimeLabel !== null && row.resetLabel !== null ? ` · ${row.resetLabel}` : ""}
      </span>
    </div>
  );
}

function MissingRow({ label }: { readonly label: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate text-[15px] text-[var(--personal-text)]">{label}</span>
      <span className="shrink-0 text-[13px] text-[var(--personal-text-secondary)]">
        not reported
      </span>
    </div>
  );
}

/**
 * The money card (DeepSeek): what is left, what our own transcript records
 * say the turns so far cost, and the credit split behind the balance. The
 * spent line is the API-price value at DeepSeek's published Flash rates, and
 * when there is nothing to price it says so plainly instead of inventing a
 * figure; the balance endpoint stays the independent check.
 */
function BalanceRows({
  balance,
  now,
}: {
  readonly balance: UsageBalanceView;
  readonly now: number;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[15px] text-[var(--personal-text)]">Balance left</span>
        <span className="shrink-0 text-[15px] font-semibold text-[var(--personal-text)] tabular-nums">
          {formatBalanceAmount(balance.total, balance.currency)}
        </span>
      </div>
      <span
        className={cn(
          "text-[13px] tabular-nums",
          balance.spent === null
            ? "text-[var(--personal-text-tertiary)]"
            : "text-[var(--personal-text-secondary)]",
        )}
      >
        {deepSeekSpendText(balance.spent, now)}
      </span>
      <span className="text-[13px] text-[var(--personal-text-secondary)] tabular-nums">
        Granted {formatBalanceAmount(balance.granted, balance.currency)} · Topped up{" "}
        {formatBalanceAmount(balance.toppedUp, balance.currency)}
      </span>
      {/*
        The low-balance line. Only a working account gets it: an unavailable one
        already has the stronger line below, and a quiet figure we could not read
        is never a warning (a failed read keeps the last good numbers, which is
        what this reads). A balance of zero is called empty here, the words the
        push uses, rather than being read out as "$0.00".
      */}
      {balance.isAvailable &&
      isLowProviderBalance({ currency: balance.currency, totalBalance: balance.total }) ? (
        <span className="text-[13px] text-warning">
          {balance.total > 0
            ? `DeepSeek balance is ${formatBalanceAmount(balance.total, balance.currency)}.`
            : "DeepSeek balance is empty."}{" "}
          Top up to keep DeepSeek bots running.{" "}
          <a
            className="underline underline-offset-2"
            href={DEEPSEEK_TOP_UP_URL}
            rel="noreferrer"
            target="_blank"
          >
            Top up
          </a>
        </span>
      ) : null}
      {balance.isAvailable ? null : (
        <span className="text-[13px] text-[var(--personal-review-text)]">
          This account cannot make API calls right now.
        </span>
      )}
    </div>
  );
}

/**
 * Under a card: how old its reading is, a small "Refreshing" beside that while
 * a probe runs (the bars stay), and, once a refresh has failed, why the bars
 * are older than they should be. A money card's age is the balance's own
 * fetch time, which the server may have served from its cache.
 */
function UsageCardFooter({
  card,
  now,
  checking,
}: {
  readonly card: UsageCard;
  readonly now: number;
  readonly checking: boolean;
}): JSX.Element | null {
  const updatedAt = card.balance?.fetchedAt ?? card.checkedAt;
  const failure = checking ? null : usageRefreshFailureText(card);
  if (updatedAt === null && !checking && failure === null) return null;
  return (
    <div className="flex flex-col gap-0.5 text-[13px] text-[var(--personal-text-secondary)]">
      {updatedAt !== null || checking ? (
        <span className="flex items-center gap-2">
          {updatedAt !== null ? <span>Updated {formatRelativeTime(updatedAt, now)}</span> : null}
          {checking ? (
            <span role="status" className="inline-flex items-center gap-1">
              <RefreshCw aria-hidden="true" className="size-3 animate-spin" strokeWidth={2} />
              Refreshing
            </span>
          ) : null}
        </span>
      ) : null}
      {failure !== null ? (
        <span className="text-[var(--personal-review-text)]">{failure}</span>
      ) : null}
    </div>
  );
}

function UsageCardView({
  card,
  now,
  checking,
  environmentId,
  onRedeemed,
  spendLine,
}: {
  readonly card: UsageCard;
  readonly now: number;
  readonly checking: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly onRedeemed: () => void;
  /** A dollar line under the windows (OpenCode's API-price value), or null. */
  readonly spendLine?: string | null;
}) {
  // Once a credit has been shown, keep the redeem block mounted for the life
  // of the sheet: spending the last one must not take its outcome with it.
  const [creditsShown, setCreditsShown] = useState(false);
  if (!creditsShown && (card.resetCredits?.credits.availableCount ?? 0) > 0) setCreditsShown(true);
  const resetCredits = card.resetCredits;
  // shrink-0: the sheet scroller is a flex column, and an overflow-hidden card
  // could shrink below its content once both cards no longer fit, cutting off
  // its bottom padding and "Updated" line.
  return (
    <article
      aria-label={`${card.title} usage`}
      className="flex shrink-0 flex-col gap-4 overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4"
    >
      <div className="flex min-w-0 flex-col">
        <h3 className="flex items-center gap-2 text-[16px] font-semibold text-[var(--personal-text)]">
          <span
            aria-hidden="true"
            data-testid="usage-provider-dot"
            data-provider={usageProviderOfDriver(card.driver)}
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: providerColor(usageProviderOfDriver(card.driver)) }}
          />
          <span className="min-w-0">{card.title}</span>
        </h3>
        {card.plan ? (
          <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
            {card.plan}
          </span>
        ) : null}
      </div>
      {card.status === "ready" && card.balance !== null ? (
        <BalanceRows balance={card.balance} now={now} />
      ) : card.status === "ready" ? (
        <>
          <div className="flex flex-col gap-4">
            {card.windows && card.windows.length > 0 ? (
              card.windows.map((row) => <WindowRow key={row.id} card={card} row={row} />)
            ) : (
              <>
                {card.session ? (
                  <WindowRow card={card} row={card.session} />
                ) : (
                  <MissingRow label="5-hour session" />
                )}
                {card.weeklies.length > 0 ? (
                  card.weeklies.map((row) => <WindowRow key={row.id} card={card} row={row} />)
                ) : (
                  <MissingRow label="Weekly" />
                )}
              </>
            )}
          </div>
          {spendLine ? (
            <p className="text-[13px] leading-5 text-[var(--personal-text-secondary)]">
              {spendLine}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-[14px] text-[var(--personal-text-secondary)]">
          {usageCardEmptyText(card, { checking })}
        </p>
      )}
      {environmentId !== null && resetCredits !== null && creditsShown ? (
        <ChunkLoadBoundary>
          <Suspense fallback={null}>
            <PersonalResetCredits
              environmentId={environmentId}
              title={card.title}
              resetCredits={resetCredits}
              now={now}
              onRedeemed={onRedeemed}
            />
          </Suspense>
        </ChunkLoadBoundary>
      ) : null}
      <UsageCardFooter card={card} now={now} checking={checking} />
    </article>
  );
}

/**
 * Sheet body: every window both providers report, with resets and a refresh.
 * Mounted only while the sheet is open, so the refresh command and the
 * providers atom cost nothing on the Chats screen's first paint.
 */
function UsageSheetBody({
  cards,
  now,
}: {
  readonly cards: readonly UsageCard[];
  readonly now: number;
}): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const tokenUsage = usePersonalTokenUsage(environmentId);
  const openCodeSpend = selectOpenCodeSpendLine(tokenUsage.data);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  // Any probe on the page, including the strip's own first reading.
  const probing = useUsageRefreshing();
  // The sheet opens on whatever snapshot the app already had. Before this, a
  // snapshot taken before any probe rendered as "not reported", which is why
  // the refresh button looked like it fixed a bug: it was doing the first
  // probe. Opening is the ask, so opening probes.
  const probedRef = useRef(false);

  const onRefresh = async () => {
    if (environmentId === null || refreshing) return;
    setRefreshing(true);
    try {
      await trackUsageRefresh(refreshProviders({ environmentId, input: { refreshUsage: true } }));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (probedRef.current || environmentId === null) return;
    if (!usageNeedsRefreshOnOpen(cards, Date.now())) return;
    probedRef.current = true;
    void onRefresh();
    // Once per mount, and the body is mounted only while the sheet is open.
  }, [environmentId]);

  return (
    <>
      <div data-sheet-drag-zone="" className="flex touch-none items-center gap-1 py-2 pr-2 pl-5">
        <div className="min-w-0 flex-1">
          <SheetTitle className="text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            Usage
          </SheetTitle>
          <SheetDescription className="text-[13px] text-[var(--personal-text-tertiary)]">
            {usageSheetDescription(cards)}
          </SheetDescription>
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={environmentId === null || refreshing}
          aria-busy={refreshing}
          aria-label="Refresh usage"
          className={`${ICON_BUTTON} disabled:opacity-40`}
        >
          <RefreshCw
            aria-hidden="true"
            className={`size-5 ${refreshing ? "animate-spin" : ""}`}
            strokeWidth={1.75}
          />
        </button>
        <SheetClose aria-label="Close usage" className={ICON_BUTTON}>
          <X aria-hidden="true" className="size-[22px]" strokeWidth={1.75} />
        </SheetClose>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-5 pb-5">
        {cards.map((card) => (
          <UsageCardView
            key={card.driver}
            card={card}
            now={now}
            checking={refreshing || probing}
            environmentId={environmentId}
            onRedeemed={() => void onRefresh()}
            spendLine={card.driver === "opencode" ? openCodeSpend : null}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Slim two-up usage strip for the Chats screen: Claude left, Codex right,
 * each showing the 5-hour session and weekly figures over one hairline bar
 * filled to whichever of the two is further spent (see `stripCellBarPercent`).
 * Renders nothing until the config stream publishes a provider, so a
 * cold start never reserves space it cannot fill. Tapping opens the full
 * per-window detail sheet.
 *
 * `now` comes from the screen's minute clock rather than a second interval
 * of its own: reset countdowns only need minute resolution.
 */
export function PersonalUsageStrip({ now }: { readonly now: number }): JSX.Element | null {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const environmentId = usePersonalEnvironmentId();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const hidden = useHiddenUsageProviders(environmentId);
  const dragRef = useSheetDragDismiss(() => setOpen(false));

  // The bars should not wait for the sheet to be opened: ask for the reading
  // the sheet would ask for, once, when the list first has providers (and again
  // only if a card later has nothing to show, or a window has reset since it
  // was read).
  useEffect(() => {
    if (environmentId === null) return;
    const at = Date.now();
    const due = usageAutoProbeDue({
      cards: selectUsageCards(providers, at, hidden),
      now: at,
      lastProbeAt: autoProbe.lastProbeAt,
      firstLoad: !autoProbe.firstLoadSeen,
    });
    if (providers.length > 0) autoProbe.firstLoadSeen = true;
    if (!due) return;
    autoProbe.lastProbeAt = at;
    void trackUsageRefresh(refreshProviders({ environmentId, input: { refreshUsage: true } }));
    // Each new provider snapshot is a chance, and so is each minute tick: a
    // window can reset while the list sits open. `refreshProviders` only
    // wraps the RPC.
  }, [environmentId, providers, now, hidden]);

  const cards = selectUsageCards(providers, now, hidden);
  const cells = selectUsageStripCells(cards);
  if (cells.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={usageStripAriaLabel(cells)}
        aria-haspopup="dialog"
        className={cn(
          "mt-0.5 min-h-11 w-full items-center gap-2 rounded-[var(--personal-radius-button)] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
          cells.length === 1
            ? "grid grid-cols-1"
            : cells.length === 2
              ? "grid grid-cols-2"
              : cells.length === 3
                ? "grid grid-cols-3"
                : "flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {cells.map((cell) => (
          // A container so the figures can fit the cell they are given: the
          // desktop list is as narrow as 280px, where both windows at a
          // readable size ran into the next cell ("59% used Session 2%").
          <span
            key={cell.driver}
            className={cn(
              "@container flex min-w-0 flex-col gap-0.5",
              cells.length >= 4 && "min-w-[110px] flex-1 shrink-0",
            )}
          >
            <span className="truncate text-[12px] leading-4 font-semibold text-[var(--personal-text-secondary)] md:text-[13px]">
              {cell.title}
            </span>
            {/* Phone: both windows at 11px, as before. md+: 12px, both windows
                where the cell is wide enough, else only the one the bar is
                filled to (the sheet and the label carry the other). */}
            <span className="truncate text-[11px] leading-4 text-[var(--personal-text-tertiary)] tabular-nums md:text-[12px]">
              <span className="md:hidden md:@min-[180px]:inline">
                {cell.sessionPercent === null && cell.weeklyPercent === null ? (
                  "Not reported"
                ) : cell.weeklyPercent === null ? (
                  <span className={bindingInk(cell, "session")}>
                    {`Sess ${formatStripPercent(cell.sessionPercent)}`}
                  </span>
                ) : (
                  <>
                    <span className={bindingInk(cell, "session")}>
                      {`Sess ${formatStripPercent(cell.sessionPercent)}`}
                    </span>
                    {" · "}
                    <span className={bindingInk(cell, "weekly")}>
                      {`Wk ${formatStripPercent(cell.weeklyPercent)}`}
                    </span>
                  </>
                )}
              </span>
              <ShortWindowFigure cell={cell} />
            </span>
            <StripCellBar percent={stripCellBarPercent(cell)} />
          </span>
        ))}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup
          ref={dragRef}
          side="bottom"
          showCloseButton={false}
          forceBackdrop
          backdropClassName="bg-background/70 backdrop-blur-md"
          className="personal-app max-h-[90dvh] rounded-t-[var(--personal-radius-card)] border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
        >
          {open ? <UsageSheetBody cards={cards} now={now} /> : null}
        </SheetPopup>
      </Sheet>
    </>
  );
}
