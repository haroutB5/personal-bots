import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { lazy, Suspense, useEffect, useRef, useState, type JSX } from "react";
import { RefreshCw, X } from "lucide-react";

import { Sheet, SheetClose, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { cn } from "~/lib/utils";
import { primaryServerProvidersAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { formatRelativeTime } from "./relativeTime";
import { usePersonalEnvironmentId } from "./usePersonalBots";
import {
  selectUsageCards,
  usageCardEmptyText,
  usageNeedsRefreshOnOpen,
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

// Upstream's reset-credit module brings the whole Limits tab with it; load it
// only once a sheet shows a banked credit.
const PersonalResetCredits = lazy(() => import("./PersonalResetCredits"));

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
  return (
    <span className={cn("hidden md:inline md:@min-[196px]:hidden", bindingInk(cell, window))}>
      {nothing
        ? "Not reported"
        : `${window === "session" ? "Session" : "Weekly"} ${formatStripPercent(
            window === "session" ? cell.sessionPercent : cell.weeklyPercent,
          )} used`}
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
          {row.usedPercent}% used
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

function UsageCardView({
  card,
  now,
  checking,
  environmentId,
  onRedeemed,
}: {
  readonly card: UsageCard;
  readonly now: number;
  readonly checking: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly onRedeemed: () => void;
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
        <h3 className="text-[16px] font-semibold text-[var(--personal-text)]">{card.title}</h3>
        {card.plan ? (
          <span className="truncate text-[13px] text-[var(--personal-text-secondary)]">
            {card.plan}
          </span>
        ) : null}
      </div>
      {card.status === "ready" ? (
        <div className="flex flex-col gap-4">
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
        </div>
      ) : (
        <p className="text-[14px] text-[var(--personal-text-secondary)]">
          {usageCardEmptyText(card, { checking })}
        </p>
      )}
      {environmentId !== null && resetCredits !== null && creditsShown ? (
        <Suspense fallback={null}>
          <PersonalResetCredits
            environmentId={environmentId}
            title={card.title}
            resetCredits={resetCredits}
            now={now}
            onRedeemed={onRedeemed}
          />
        </Suspense>
      ) : null}
      {card.checkedAt !== null ? (
        <span className="text-[13px] text-[var(--personal-text-secondary)]">
          Updated {formatRelativeTime(card.checkedAt, now)}
        </span>
      ) : null}
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
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  // The sheet opens on whatever snapshot the app already had. Before this, a
  // snapshot taken before any probe rendered as "not reported", which is why
  // the refresh button looked like it fixed a bug: it was doing the first
  // probe. Opening is the ask, so opening probes.
  const probedRef = useRef(false);

  const onRefresh = async () => {
    if (environmentId === null || refreshing) return;
    setRefreshing(true);
    try {
      await refreshProviders({ environmentId, input: { refreshUsage: true } });
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
      <div className="flex items-center gap-1 py-2 pr-2 pl-5">
        <div className="min-w-0 flex-1">
          <SheetTitle className="text-[17px] leading-[22px] font-semibold text-[var(--personal-text)]">
            Usage
          </SheetTitle>
          <SheetDescription className="text-[13px] text-[var(--personal-text-tertiary)]">
            Token windows for Claude and Codex
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
            checking={refreshing}
            environmentId={environmentId}
            onRedeemed={() => void onRefresh()}
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
  const [open, setOpen] = useState(false);

  const cards = selectUsageCards(providers, now);
  const cells = selectUsageStripCells(cards);
  if (cells.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={usageStripAriaLabel(cells)}
        aria-haspopup="dialog"
        className="mt-0.5 grid min-h-11 w-full grid-cols-2 items-center gap-3 rounded-[var(--personal-radius-button)] text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        {cells.map((cell) => (
          // A container so the figures can fit the cell they are given: the
          // desktop list is as narrow as 280px, where both windows at a
          // readable size ran into the next cell ("59% used Session 2%").
          <span key={cell.driver} className="@container flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-[12px] leading-4 font-semibold text-[var(--personal-text-secondary)] md:text-[13px]">
              {cell.title}
            </span>
            {/* Phone: both windows at 11px, as before. md+: 12px, both windows
                where the cell is wide enough, else only the one the bar is
                filled to (the sheet and the label carry the other). */}
            <span className="truncate text-[11px] leading-4 text-[var(--personal-text-tertiary)] tabular-nums md:text-[12px]">
              <span className="md:hidden md:@min-[196px]:inline">
                {cell.sessionPercent === null && cell.weeklyPercent === null ? (
                  // Nothing reported yet: "Session – · Weekly – used" read as a
                  // broken line of dashes.
                  "Not reported"
                ) : (
                  <>
                    <span className={bindingInk(cell, "session")}>
                      Session {formatStripPercent(cell.sessionPercent)}
                    </span>{" "}
                    ·{" "}
                    <span className={bindingInk(cell, "weekly")}>
                      Weekly {formatStripPercent(cell.weeklyPercent)} used
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
