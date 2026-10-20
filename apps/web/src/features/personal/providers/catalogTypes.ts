/**
 * Client-side mirror of packages/contracts/src/providerCatalog.ts (commit 1362f30b49).
 * Used until Backend's RPCs and contracts are merged directly into this branch.
 */

export type ProviderCatalogId = string;

export type ProviderCatalogSource = "builtIn" | "registry";

export type ProviderCatalogCostKind =
  | "subscription"
  | "free"
  | "freeTier"
  | "apiKey"
  | "payAsYouGo"
  | "byok"
  | "unknown";

export interface ProviderCatalogCost {
  readonly kind: ProviderCatalogCostKind;
  readonly label: string;
  readonly detail: string | null;
}

export type ProviderCatalogDistributionKind = "binary" | "npm" | "uvx";

export interface ProviderCatalogDistribution {
  readonly kind: ProviderCatalogDistributionKind;
  /** "npm · @google/gemini-cli", "GitHub release · block/goose", "Google download". */
  readonly label: string;
}

export type ProviderCatalogUnsupportedReason =
  | "needsUv"
  | "noWindowsBuild"
  | "needsNode"
  | "noChecksum"
  | "unpinnedVersion"
  | "unsupportedArchive"
  | "badDistribution";

export type ProviderCatalogSupport =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ProviderCatalogUnsupportedReason };

export interface ProviderCatalogEntry {
  readonly catalogId: ProviderCatalogId;
  readonly source: ProviderCatalogSource;
  readonly name: string;
  readonly publisher: string;
  readonly description: string;
  readonly website: string | null;
  readonly repository: string | null;
  readonly license: string;
  readonly openSource: boolean;
  readonly version: string | null;
  readonly iconUrl: string | null;
  readonly distribution: ProviderCatalogDistribution | null;
  readonly downloadBytes: number | null;
  readonly sha256Checked: boolean;
  readonly cost: ProviderCatalogCost;
  readonly signInLabel: string | null;
  readonly popularRank: number | null;
  readonly supported: ProviderCatalogSupport;
  readonly added: { readonly instanceId: string } | null;
}

export interface ProviderCatalogListInput {
  readonly refresh?: boolean;
}

export interface ProviderCatalogListResult {
  readonly entries: ReadonlyArray<ProviderCatalogEntry>;
  readonly registryFetchedAt: string | null;
  readonly registryStale: boolean;
}

export interface ProviderCatalogAddInput {
  readonly catalogId: ProviderCatalogId;
}

export interface ProviderCatalogAddResult {
  readonly instanceId: string;
}

export interface ProviderCatalogInstallFactsInput {
  readonly catalogId: ProviderCatalogId;
}

export type ProviderInstallFailureKind =
  | "network"
  | "checksum"
  | "disk"
  | "wontStart"
  | "unsupported"
  | "npm"
  | "other";

export interface ProviderInstallFailure {
  readonly kind: ProviderInstallFailureKind;
  readonly detail: string;
  readonly neededBytes?: number;
  readonly freeBytes?: number;
  readonly host?: string;
}

export type ProviderCatalogInstallPhase =
  | "idle"
  | "resolving"
  | "downloading"
  | "extracting"
  | "verifying"
  | "starting"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ProviderCatalogInstallState {
  readonly catalogId: ProviderCatalogId;
  readonly operationId: string | null;
  readonly phase: ProviderCatalogInstallPhase;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly version: string | null;
  readonly installedVersion: string | null;
  readonly previousVersion: string | null;
  readonly canRemove: boolean;
  readonly message: string | null;
  readonly failure: ProviderInstallFailure | null;
}

export interface ProviderCatalogInstallPlan {
  readonly catalogId: ProviderCatalogId;
  readonly version: string;
  readonly distribution: ProviderCatalogDistribution;
  readonly downloadBytes: number | null;
  readonly requiredBytes: number;
  readonly sha256Checked: boolean;
  readonly host: string | null;
  readonly runsInstallScripts: boolean;
}
