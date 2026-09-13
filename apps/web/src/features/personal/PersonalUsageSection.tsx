import { useAtomValue } from "@effect/atom-react";
import { useState, type JSX } from "react";
import { RefreshCw } from "lucide-react";

import { primaryServerProvidersAtom, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { formatRelativeTime } from "./relativeTime";
import { useMinuteNow } from "./useMinuteNow";
import { usePersonalEnvironmentId } from "./usePersonalBots";
import { selectUsageCards, type UsageCard, type UsageWindowRow } from "./usagePresentation";

const CARD =
  "overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]";

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
        className="h-2.5 overflow-hidden rounded-full bg-[var(--personal-fill-muted)]"
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
        {row.resetLabel ?? "Reset time not reported"}
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

function UsageCardView({ card, now }: { readonly card: UsageCard; readonly now: number }) {
  return (
    <article aria-label={`${card.title} usage`} className={`${CARD} flex flex-col gap-4 p-4`}>
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
          {card.weekly ? (
            <WindowRow card={card} row={card.weekly} />
          ) : (
            <MissingRow label="Weekly" />
          )}
        </div>
      ) : (
        <p className="text-[14px] text-[var(--personal-text-secondary)]">
          {card.status === "unavailable"
            ? (card.notice ?? "This account has no subscription limits.")
            : (card.notice ?? "Usage is not reported for this account yet.")}
        </p>
      )}
      {card.checkedAt !== null ? (
        <span className="text-[13px] text-[var(--personal-text-secondary)]">
          Updated {formatRelativeTime(card.checkedAt, now)}
        </span>
      ) : null}
    </article>
  );
}

/** Token/quota windows for Claude and GPT: 5-hour session plus weekly, with resets. */
export function PersonalUsageSection(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const now = useMinuteNow();
  const [refreshing, setRefreshing] = useState(false);

  const cards = selectUsageCards(providers, now);

  const onRefresh = async () => {
    if (environmentId === null || refreshing) return;
    setRefreshing(true);
    try {
      await refreshProviders({ environmentId, input: {} });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section aria-labelledby="settings-usage">
      <div className="mb-2 flex items-center justify-between gap-3 px-1">
        <h2
          id="settings-usage"
          className="text-[13px] font-semibold tracking-wide text-[var(--personal-text-secondary)] uppercase"
        >
          Usage
        </h2>
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={environmentId === null || refreshing}
          aria-busy={refreshing}
          aria-label="Refresh usage"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-[var(--personal-radius-button)] px-3 text-[13px] font-semibold text-[var(--personal-text-secondary)] outline-none disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <RefreshCw
            aria-hidden="true"
            className={`size-5 ${refreshing ? "animate-spin" : ""}`}
            strokeWidth={1.75}
          />
        </button>
      </div>
      {cards.length === 0 ? (
        <p className="px-1 text-sm text-[var(--personal-text-secondary)]">
          Usage isn&apos;t reported for your providers yet.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map((card) => (
            <UsageCardView key={card.driver} card={card} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}
