import type { JSX } from "react";
import { useId, useMemo, useRef, useState } from "react";

import { useAtomValue } from "@effect/atom-react";
import { Link, useSearch } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight, MessageSquare, Search, X } from "lucide-react";

import { primaryServerProvidersAtom } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";

import {
  CATALOG_FILTERS,
  highlightNameMatch,
  partitionCatalog,
  type CatalogFilter,
} from "./catalogModel";
import { providerCatalogList } from "./catalogClient";
import { deriveBuiltInCatalogEntries } from "./catalogModel";
import type { ProviderCatalogEntry, ProviderCatalogListResult } from "./catalogTypes";
import { useProviderInstallStates } from "./providerInstallStates";
import {
  BUTTON_PRIMARY,
  CARD,
  ProviderCatalogueSkeleton,
  ProviderNote,
  ProviderTile,
  SECTION_TITLE,
} from "./providerUi";
import { usePersonalBotsList, usePersonalEnvironmentId } from "../usePersonalBots";

/**
 * Add provider (SPEC §4): Browse the ACP registry catalogue (Popular first,
 * All, chip filters, search), see added status, and tap to view details or install.
 */
export function AddProviderScreen(): JSX.Element {
  const environmentId = usePersonalEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const botsQuery = usePersonalBotsList(environmentId);
  const bots = botsQuery.data?.bots ?? [];
  const { watchers } = useProviderInstallStates(environmentId, providers);
  const searchInputId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Search and filter params from URL if available, else local state
  const rawSearch = useSearch({ strict: false }) as {
    q?: string;
    f?: CatalogFilter;
    return?: string;
  };
  const returnTarget = rawSearch.return;

  const [query, setQuery] = useState(rawSearch.q ?? "");
  const [filter, setFilter] = useState<CatalogFilter>(
    rawSearch.f === "subscription" || rawSearch.f === "apiKey" || rawSearch.f === "free"
      ? rawSearch.f
      : "all",
  );
  const [refreshing, setRefreshing] = useState(false);

  // Query catalog from server
  const catalogQuery = useEnvironmentQuery(
    environmentId !== null
      ? providerCatalogList({ environmentId, input: { refresh: refreshing } })
      : null,
  );

  const catalogData = catalogQuery.data as ProviderCatalogListResult | null | undefined;
  const rawEntries: ReadonlyArray<ProviderCatalogEntry> = useMemo(() => {
    if (catalogData?.entries && catalogData.entries.length > 0) {
      return catalogData.entries;
    }
    return deriveBuiltInCatalogEntries(providers);
  }, [catalogData, providers]);

  // Merge live provider snapshots into entry.added status
  const entries: ReadonlyArray<ProviderCatalogEntry> = useMemo(() => {
    return rawEntries.map((entry) => {
      // Find matching live provider
      const live = providers.find((p) => {
        if (entry.source === "builtIn") {
          const builtinDriver = entry.catalogId.replace(/^builtin:/, "");
          return p.driver === builtinDriver;
        }
        const cfg = (p as unknown as { config?: { catalogId?: string } }).config;
        return cfg?.catalogId === entry.catalogId || p.instanceId === entry.catalogId;
      });

      if (live !== undefined && live.installed) {
        return { ...entry, added: { instanceId: live.instanceId } };
      }
      return entry;
    });
  }, [rawEntries, providers]);

  const partition = useMemo(
    () => partitionCatalog(entries, filter, query),
    [entries, filter, query],
  );

  const isStale = catalogData?.registryStale === true;
  const fetchFailed = catalogQuery.error !== null;
  const isLoading = catalogQuery.isPending && !catalogQuery.data;
  const showFallbackNote =
    fetchFailed || (!isLoading && (!catalogData?.entries || catalogData.entries.length === 0));

  const clearSearch = () => {
    setQuery("");
    searchInputRef.current?.focus();
  };

  const ctoBot = useMemo(() => bots.find((b) => b.name.toLowerCase() === "cto"), [bots]);

  const ctoAskDraft = `Can we add ${query.trim()} as a provider?`;
  const ctoLink = ctoBot
    ? `/bots/${ctoBot.botId}?draft=${encodeURIComponent(ctoAskDraft)}`
    : `/bots?draft=${encodeURIComponent(ctoAskDraft)}`;

  return (
    <div className="flex flex-col px-5 pb-10" data-add-provider-screen>
      {watchers}
      <header className="sticky top-0 z-10 flex h-14 items-center gap-1 bg-[var(--personal-bg)]">
        <Link
          to={returnTarget === "botform" ? "/bots/new" : "/bots/settings"}
          aria-label="Back"
          className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
        </Link>
        <h1 className="min-w-0 flex-1 truncate text-[19px] font-bold text-[var(--personal-text)]">
          Add provider
        </h1>
      </header>

      {/* Search field (SPEC §4) */}
      <div className="relative mt-1 flex items-center">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 size-5 text-[var(--personal-text-secondary)]"
          strokeWidth={1.75}
        />
        <input
          ref={searchInputRef}
          id={searchInputId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${entries.length} providers`}
          enterKeyHint="search"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          className="h-11 w-full rounded-[12px] border border-transparent bg-[var(--personal-fill-muted)] pl-10 pr-10 text-[15px] text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus:border-[var(--personal-border-strong)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        />
        {query.length > 0 ? (
          <button
            type="button"
            onClick={clearSearch}
            aria-label="Clear search"
            className="absolute right-0 flex size-11 items-center justify-center rounded-full text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {/* Filter chips (SPEC §4) */}
      <div
        role="radiogroup"
        aria-label="Filter providers"
        className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-1"
      >
        {CATALOG_FILTERS.map((chip) => {
          const selected = filter === chip.id;
          return (
            <button
              key={chip.id}
              role="radio"
              aria-checked={selected}
              onClick={() => setFilter(chip.id)}
              className="flex h-11 shrink-0 items-center px-0.5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:rounded-full"
            >
              <span
                className={`flex h-8 items-center rounded-full px-3 text-[13px] font-semibold transition-colors ${
                  selected
                    ? "bg-[var(--personal-text)] text-[var(--personal-bg)]"
                    : "bg-[var(--personal-fill-muted)] text-[var(--personal-text-secondary)] hover:text-[var(--personal-text)]"
                }`}
              >
                {chip.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Fetch error note */}
      {showFallbackNote ? (
        <div className="mt-4">
          <ProviderNote
            tone="info"
            title="Couldn't load the full list"
            actions={
              <button type="button" onClick={() => setRefreshing(true)} className={BUTTON_PRIMARY}>
                Try again
              </button>
            }
          >
            Showing the built in providers.
          </ProviderNote>
        </div>
      ) : null}

      {/* Content */}
      <div className="mt-4 flex flex-col gap-6">
        {isLoading ? (
          <ProviderCatalogueSkeleton />
        ) : partition.mode === "search" ? (
          partition.items.length === 0 ? (
            /* Frame add-empty (SPEC §4) */
            <div className="flex flex-col items-center px-4 py-8 text-center" data-empty-results>
              <h2 className="text-[17px] font-bold text-[var(--personal-text)]">
                Nothing called &ldquo;{partition.query}&rdquo;
              </h2>
              <p className="mt-2 max-w-sm text-[14px] leading-5 text-[var(--personal-text-secondary)]">
                This list is every agent in the ACP registry, checked daily. One that isn&apos;t on
                it can&apos;t run in hbots yet.
              </p>
              <Link to={ctoLink} className={`${BUTTON_PRIMARY} mt-5 gap-2`}>
                <MessageSquare className="size-4" />
                Ask CTO about it
              </Link>
            </div>
          ) : (
            <section aria-label="Search results">
              <h2 className={SECTION_TITLE}>{partition.title}</h2>
              <CatalogList
                entries={partition.items}
                searchQuery={partition.query}
                returnTarget={returnTarget}
              />
            </section>
          )
        ) : partition.mode === "filtered" ? (
          <section aria-label={partition.title}>
            <h2 className={SECTION_TITLE}>{partition.title}</h2>
            <CatalogList entries={partition.items} searchQuery="" returnTarget={returnTarget} />
          </section>
        ) : (
          /* Sections mode (Popular, All A to Z) */
          <>
            {partition.popular.length > 0 ? (
              <section aria-labelledby="catalog-popular-title">
                <h2 id="catalog-popular-title" className={SECTION_TITLE}>
                  Popular
                </h2>
                <CatalogList
                  entries={partition.popular}
                  searchQuery=""
                  returnTarget={returnTarget}
                />
              </section>
            ) : null}
            <section aria-labelledby="catalog-all-title">
              <h2 id="catalog-all-title" className={SECTION_TITLE}>
                All providers, A to Z
              </h2>
              <CatalogList entries={partition.allAtoZ} searchQuery="" returnTarget={returnTarget} />
            </section>
          </>
        )}

        {/* Footnote (SPEC §4) */}
        {!isLoading && partition.mode !== "search" ? (
          <p className="px-1 text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            Built in providers are made and tested for hbots. The rest come from the ACP registry,
            an open list of coding agents. hbots runs them the same way, but the team hasn&apos;t
            tested each one.
            {isStale ? " List from 3 days ago." : ""}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CatalogList({
  entries,
  searchQuery,
  returnTarget,
}: {
  readonly entries: ReadonlyArray<ProviderCatalogEntry>;
  readonly searchQuery: string;
  readonly returnTarget?: string | undefined;
}): JSX.Element {
  return (
    <ul className={`${CARD} divide-y divide-[var(--personal-border)]`}>
      {entries.map((entry) => (
        <CatalogRow
          key={entry.catalogId}
          entry={entry}
          searchQuery={searchQuery}
          returnTarget={returnTarget}
        />
      ))}
    </ul>
  );
}

function CatalogRow({
  entry,
  searchQuery,
  returnTarget,
}: {
  readonly entry: ProviderCatalogEntry;
  readonly searchQuery: string;
  readonly returnTarget?: string | undefined;
}): JSX.Element {
  const isAdded = entry.added !== null;
  const href = isAdded
    ? `/bots/settings/providers/${entry.added.instanceId}`
    : `/bots/settings/providers/catalog/${entry.catalogId}`;

  const queryParams = returnTarget ? { return: returnTarget } : {};
  const highlightedParts = highlightNameMatch(entry.name, searchQuery);

  return (
    <li data-catalog-row={entry.catalogId}>
      <Link
        to={href}
        search={queryParams}
        className="flex min-h-16 items-center gap-3 px-3.5 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
      >
        <ProviderTile
          driver={
            entry.source === "builtIn" ? (entry.catalogId.replace(/^builtin:/, "") as any) : null
          }
          label={entry.name}
          iconUrl={entry.iconUrl}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
              {highlightedParts.map((part, index) =>
                part.matched ? (
                  <mark
                    key={index}
                    className="rounded-[2px] bg-[color-mix(in_srgb,var(--personal-text)_18%,transparent)] text-inherit"
                  >
                    {part.text}
                  </mark>
                ) : (
                  part.text
                ),
              )}
            </span>
            {entry.source === "builtIn" ? (
              <span className="shrink-0 rounded-full border border-[var(--personal-border-strong)] px-1.5 text-[11px] leading-4 font-semibold text-[var(--personal-text-secondary)]">
                Built in
              </span>
            ) : null}
          </div>
          <span className="truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
            {entry.publisher}
            {entry.cost.label ? ` · ${entry.cost.label}` : ""}
          </span>
          <span className="truncate text-[13px] leading-[18px] text-[var(--personal-text-tertiary)]">
            {entry.description}
          </span>
        </div>
        {isAdded ? (
          <span className="flex shrink-0 items-center gap-1 text-[13px] font-semibold text-[var(--personal-text-secondary)]">
            <Check className="size-4" strokeWidth={2} />
            Added
          </span>
        ) : (
          <ChevronRight
            aria-hidden="true"
            className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
            strokeWidth={1.75}
          />
        )}
      </Link>
    </li>
  );
}
