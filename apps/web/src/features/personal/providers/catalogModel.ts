import type { ServerProvider } from "@t3tools/contracts";
import { resolveBotProvider } from "../botSummaries";
import type {
  ProviderCatalogCost,
  ProviderCatalogEntry,
  ProviderCatalogUnsupportedReason,
  ProviderInstallFailure,
} from "./catalogTypes";

export type CatalogFilter = "all" | "subscription" | "apiKey" | "free";

export const CATALOG_FILTERS: ReadonlyArray<{
  readonly id: CatalogFilter;
  readonly label: string;
}> = [
  { id: "all", label: "All" },
  { id: "subscription", label: "Subscription" },
  { id: "apiKey", label: "API key" },
  { id: "free", label: "Free" },
];

/**
 * Filter matching rules (SPEC §4):
 * - All: shows everything
 * - Subscription: cost.kind === "subscription"
 * - API key: cost.kind === "apiKey" | "byok" | "payAsYouGo"
 * - Free: free to start (cost.kind === "free" | "freeTier" | "byok")
 * Unknown cost appears only under All.
 */
export function filterMatches(filter: CatalogFilter, cost: ProviderCatalogCost): boolean {
  if (filter === "all") return true;
  if (cost.kind === "unknown") return false;
  switch (filter) {
    case "subscription":
      return cost.kind === "subscription";
    case "apiKey":
      return cost.kind === "apiKey" || cost.kind === "byok" || cost.kind === "payAsYouGo";
    case "free":
      return cost.kind === "free" || cost.kind === "freeTier" || cost.kind === "byok";
  }
}

/** Case and accent insensitive normalization for search. */
export function normalizeSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** Matches name, publisher, description and id, case and accent insensitive. */
export function entryMatchesSearch(entry: ProviderCatalogEntry, query: string): boolean {
  const q = normalizeSearch(query);
  if (q.length === 0) return true;
  return (
    normalizeSearch(entry.name).includes(q) ||
    normalizeSearch(entry.publisher).includes(q) ||
    normalizeSearch(entry.description).includes(q) ||
    normalizeSearch(entry.catalogId).includes(q)
  );
}

/** Splits text into matched and unmatched pieces for soft highlight. */
export function highlightNameMatch(
  name: string,
  query: string,
): ReadonlyArray<{ readonly text: string; readonly matched: boolean }> {
  const q = normalizeSearch(query);
  if (q.length === 0) return [{ text: name, matched: false }];

  const normName = name.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const lowerNorm = normName.toLowerCase();
  const index = lowerNorm.indexOf(q);
  if (index === -1) return [{ text: name, matched: false }];

  // Find corresponding character indices in original string
  const before = name.slice(0, index);
  const matched = name.slice(index, index + q.length);
  const after = name.slice(index + q.length);

  const parts: Array<{ text: string; matched: boolean }> = [];
  if (before.length > 0) parts.push({ text: before, matched: false });
  if (matched.length > 0) parts.push({ text: matched, matched: true });
  if (after.length > 0) parts.push({ text: after, matched: false });
  return parts;
}

export type CatalogPartition =
  | {
      readonly mode: "sections";
      readonly popular: ReadonlyArray<ProviderCatalogEntry>;
      readonly allAtoZ: ReadonlyArray<ProviderCatalogEntry>;
    }
  | {
      readonly mode: "filtered";
      readonly filter: CatalogFilter;
      readonly title: string;
      readonly items: ReadonlyArray<ProviderCatalogEntry>;
    }
  | {
      readonly mode: "search";
      readonly query: string;
      readonly title: string;
      readonly items: ReadonlyArray<ProviderCatalogEntry>;
    };

const byName = (left: ProviderCatalogEntry, right: ProviderCatalogEntry): number =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

export function partitionCatalog(
  entries: ReadonlyArray<ProviderCatalogEntry>,
  filter: CatalogFilter,
  searchQuery: string,
): CatalogPartition {
  const query = searchQuery.trim();
  if (query.length > 0) {
    const matched = entries
      .filter((e) => filterMatches(filter, e.cost) && entryMatchesSearch(e, query))
      .toSorted(byName);
    return {
      mode: "search",
      query,
      title: `Results · ${matched.length}`,
      items: matched,
    };
  }

  if (filter !== "all") {
    const items = entries.filter((e) => filterMatches(filter, e.cost)).toSorted(byName);
    const label =
      filter === "free" ? "Free to start" : filter === "subscription" ? "Subscription" : "API key";
    return {
      mode: "filtered",
      filter,
      title: `${label} · ${items.length}`,
      items,
    };
  }

  // filter === "all", no search
  const popular = entries
    .filter((e) => e.popularRank !== null && e.popularRank !== undefined)
    .toSorted((left, right) => (left.popularRank ?? 999) - (right.popularRank ?? 999))
    .slice(0, 6);

  const allAtoZ = entries.toSorted(byName);

  return {
    mode: "sections",
    popular,
    allAtoZ,
  };
}

/**
 * Plain words copy for unsupported reasons (SPEC §5.1 & §7).
 */
export function unsupportedReasonCopy(reason: ProviderCatalogUnsupportedReason): {
  readonly title: string;
  readonly text: string;
  readonly buttonLabel: string;
} {
  const buttonLabel = "Ask CTO to set it up";
  const title = "Can't install from the phone yet";
  switch (reason) {
    case "needsUv":
      return {
        title,
        text: "It needs uv, a Python tool that isn't on your laptop.",
        buttonLabel,
      };
    case "noWindowsBuild":
      return {
        title,
        text: "This agent doesn't have a Windows build yet.",
        buttonLabel,
      };
    case "needsNode":
      return {
        title,
        text: "It needs Node.js, which isn't on your laptop.",
        buttonLabel,
      };
    case "noChecksum":
      return {
        title,
        text: "The registry doesn't list a checksum for this download.",
        buttonLabel,
      };
    case "unpinnedVersion":
      return {
        title,
        text: "The registry doesn't pin an exact version.",
        buttonLabel,
      };
    case "unsupportedArchive":
      return {
        title,
        text: "The download is in a format hbots can't unpack.",
        buttonLabel,
      };
    case "badDistribution":
      return {
        title,
        text: "The registry entry has an unsupported distribution format.",
        buttonLabel,
      };
  }
}

/**
 * Install failure notes matching SPEC §7 errors table.
 */
export function catalogInstallFailureNote(
  failure: ProviderInstallFailure | null,
  fallbackMessage: string | null,
  providerLabel: string,
): {
  readonly tone: "danger" | "review";
  readonly title: string;
  readonly text: string;
  readonly buttons: ReadonlyArray<"tryAgain" | "removeIt">;
} {
  if (failure === null) {
    const text = fallbackMessage?.split(/\r?\n/)[0]?.slice(0, 160) ?? "Nothing was installed.";
    return {
      tone: "danger",
      title: "The install stopped",
      text,
      buttons: ["tryAgain"],
    };
  }

  switch (failure.kind) {
    case "network": {
      const host = failure.host ?? "the server";
      return {
        tone: "danger",
        title: "The download stopped",
        text: `Your laptop lost its connection to ${host}.${failure.detail ? ` It said "${failure.detail}".` : ""}`,
        buttons: ["tryAgain"],
      };
    }
    case "checksum":
      return {
        tone: "danger",
        title: "The download didn't match",
        text: "It wasn't the file the publisher listed, so hbots deleted it without running it. Try again in a few minutes.",
        buttons: ["tryAgain"],
      };
    case "disk": {
      const needed = Math.max(1, Math.round((failure.neededBytes ?? 0) / 1_000_000));
      const free = Math.max(0, Math.round((failure.freeBytes ?? 0) / 1_000_000));
      return {
        tone: "danger",
        title: "Not enough space on your laptop",
        text: `${providerLabel} needs ${needed} MB and the laptop has ${free} MB free.`,
        buttons: ["tryAgain"],
      };
    }
    case "wontStart":
      return {
        tone: "danger",
        title: "Installed, but it won't start",
        text: `${providerLabel} stopped with "${failure.detail || "unsupported platform"}". This version may not run on Windows.`,
        buttons: ["tryAgain", "removeIt"],
      };
    case "npm": {
      const pkg = failure.host ?? providerLabel;
      return {
        tone: "danger",
        title: "The download stopped",
        text: `npm couldn't get ${pkg}. It said "${failure.detail}".`,
        buttons: ["tryAgain"],
      };
    }
    case "unsupported":
      return {
        tone: "review",
        title: "Can't install from the phone yet",
        text: failure.detail || "It needs tools that aren't on your laptop.",
        buttons: ["tryAgain"],
      };
    case "other":
    default:
      return {
        tone: "danger",
        title: "The install stopped",
        text: failure.detail || fallbackMessage || "Nothing was installed.",
        buttons: ["tryAgain"],
      };
  }
}

/**
 * SPEC §4 fallback: "Couldn't load the full list, showing the built-in providers".
 * Derived strictly from live ServerProvider snapshots — no invented data, no hardcoded
 * versions or download sizes.
 */
export function deriveBuiltInCatalogEntries(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderCatalogEntry> {
  const byDriver = new Map<string, ProviderCatalogEntry>();
  for (const provider of providers) {
    if (
      provider.source === "registry" ||
      (provider.catalogId && !provider.catalogId.startsWith("builtin:"))
    )
      continue;
    const entry: ProviderCatalogEntry = {
      catalogId: `builtin:${provider.driver}`,
      source: "builtIn",
      name: provider.displayName ?? resolveBotProvider(provider.instanceId, providers).label,
      publisher: provider.publisher ?? "",
      description: "",
      website: null,
      repository: null,
      license: provider.license ?? "",
      openSource: provider.openSource ?? false,
      version: provider.version ?? null,
      iconUrl: provider.iconUrl ?? null,
      distribution: null,
      downloadBytes: null,
      sha256Checked: false,
      cost: { kind: "unknown", label: "Price not listed", detail: null },
      signInLabel: null,
      popularRank: null,
      supported: { ok: true },
      added: { instanceId: provider.instanceId },
    };
    if (!byDriver.has(provider.driver) || provider.installed) byDriver.set(provider.driver, entry);
  }
  return [...byDriver.values()];
}
