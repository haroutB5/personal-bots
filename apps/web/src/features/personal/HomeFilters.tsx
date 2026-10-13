import type { JSX } from "react";

import { cn } from "~/lib/utils";

import { HOME_FILTERS, type HomeFilter } from "./homeRows";

/**
 * The filters above the list: All, Needs you (with its count), Unread, Groups.
 * Each is a 44 px button around a 36 px pill, so the row is 52 tall and the
 * pill is the only thing that paints. The count is the needs-you model's own
 * number, the same one the tab badge shows.
 */
export function HomeFilters({
  active,
  onSelect,
  needsCount,
}: {
  readonly active: HomeFilter;
  readonly onSelect: (filter: HomeFilter) => void;
  readonly needsCount: number;
}): JSX.Element {
  return (
    <div role="tablist" aria-label="Filter chats" className="flex h-[52px] items-center gap-2">
      {HOME_FILTERS.map(({ key, label }) => {
        const on = key === active;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(key)}
            className="inline-flex h-11 shrink-0 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <span
              className={cn(
                "inline-flex h-9 items-center gap-1 rounded-full px-3.5 text-[15px] leading-5 font-semibold",
                on
                  ? "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                  : "bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)]",
              )}
            >
              {label}
              {key === "needs" ? (
                <span
                  data-testid="needs-filter-count"
                  className={cn(
                    "tabular-nums",
                    on
                      ? "text-[var(--personal-primary-text)]"
                      : "text-[var(--personal-state-needs)]",
                  )}
                >
                  {needsCount}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
