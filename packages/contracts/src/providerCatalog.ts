/**
 * Provider catalogue and registry-agent install contract (provider setup,
 * release 2: SPEC sections 11.1, 11.2 and 11.3).
 *
 * The catalogue is the built-in drivers plus the official ACP registry, with a
 * small overlay (cost, sign-in label, popularity, hidden) on top. Nothing here
 * carries a secret; URLs are public registry and download addresses only.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const CatalogText = Schema.String.check(Schema.isMaxLength(2_000));
const CatalogLabel = Schema.String.check(Schema.isMaxLength(200));
const ByteCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** `gemini` for a registry agent, `builtin:claudeAgent` for a built-in driver. */
export const ProviderCatalogId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ProviderCatalogId = typeof ProviderCatalogId.Type;

export const ProviderCatalogSource = Schema.Literals(["builtIn", "registry"]);
export type ProviderCatalogSource = typeof ProviderCatalogSource.Type;

export const ProviderCatalogCostKind = Schema.Literals([
  "subscription",
  "free",
  "freeTier",
  "apiKey",
  "payAsYouGo",
  "byok",
  "unknown",
]);
export type ProviderCatalogCostKind = typeof ProviderCatalogCostKind.Type;

export const ProviderCatalogCost = Schema.Struct({
  kind: ProviderCatalogCostKind,
  label: CatalogLabel,
  detail: Schema.NullOr(CatalogText),
});
export type ProviderCatalogCost = typeof ProviderCatalogCost.Type;

export const ProviderCatalogDistributionKind = Schema.Literals(["binary", "npm", "uvx"]);
export type ProviderCatalogDistributionKind = typeof ProviderCatalogDistributionKind.Type;

export const ProviderCatalogDistribution = Schema.Struct({
  kind: ProviderCatalogDistributionKind,
  /** "npm · @google/gemini-cli", "GitHub release · block/goose", "Google download". */
  label: CatalogLabel,
});
export type ProviderCatalogDistribution = typeof ProviderCatalogDistribution.Type;

/**
 * Why a registry agent cannot be installed from the phone. The first three are
 * the design's (SPEC 11.1); the rest come from the registry's actual data:
 * a binary archive with no sha256 (not installable in v1), an npm entry
 * without an exact version, an archive format hbots cannot unpack, and a
 * malformed or non-HTTPS entry.
 */
export const ProviderCatalogUnsupportedReason = Schema.Literals([
  "needsUv",
  "noWindowsBuild",
  "needsNode",
  "noChecksum",
  "unpinnedVersion",
  "unsupportedArchive",
  "badDistribution",
]);
export type ProviderCatalogUnsupportedReason = typeof ProviderCatalogUnsupportedReason.Type;

export const ProviderCatalogSupport = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true) }),
  Schema.Struct({ ok: Schema.Literal(false), reason: ProviderCatalogUnsupportedReason }),
]);
export type ProviderCatalogSupport = typeof ProviderCatalogSupport.Type;

export const ProviderCatalogEntry = Schema.Struct({
  catalogId: ProviderCatalogId,
  source: ProviderCatalogSource,
  name: TrimmedNonEmptyString,
  publisher: CatalogLabel,
  description: CatalogText,
  website: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  repository: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  /** SPDX id as the registry lists it, or "proprietary". */
  license: CatalogLabel,
  openSource: Schema.Boolean,
  /** Latest available version. Null only for a built-in whose driver does not report one. */
  version: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  /** Server-proxied one-colour SVG. The phone never calls the registry CDN. */
  iconUrl: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  /** Null for a built-in that has no registry distribution. */
  distribution: Schema.NullOr(ProviderCatalogDistribution),
  /** Archive size from the download's HEAD request. Null means unknown, never a guess. */
  downloadBytes: Schema.NullOr(ByteCount),
  /** True when a binary archive carries a registry sha256 that is checked before unpacking. */
  sha256Checked: Schema.Boolean,
  cost: ProviderCatalogCost,
  /** "Google account or API key". Null reads "Shown after install". */
  signInLabel: Schema.NullOr(CatalogLabel),
  popularRank: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  supported: ProviderCatalogSupport,
  added: Schema.NullOr(Schema.Struct({ instanceId: ProviderInstanceId })),
});
export type ProviderCatalogEntry = typeof ProviderCatalogEntry.Type;

export const ProviderCatalogListInput = Schema.Struct({
  /** Re-fetch the registry now instead of using the cached copy. */
  refresh: Schema.optionalKey(Schema.Boolean),
});
export type ProviderCatalogListInput = typeof ProviderCatalogListInput.Type;

export const ProviderCatalogListResult = Schema.Struct({
  entries: Schema.Array(ProviderCatalogEntry),
  /** When the registry copy in use was fetched. Null when only the bundled seed is available. */
  registryFetchedAt: Schema.NullOr(IsoDateTime),
  /** True when the copy is older than a day or the last fetch failed. */
  registryStale: Schema.Boolean,
});
export type ProviderCatalogListResult = typeof ProviderCatalogListResult.Type;

export const ProviderCatalogAddInput = Schema.Struct({
  catalogId: ProviderCatalogId,
});
export type ProviderCatalogAddInput = typeof ProviderCatalogAddInput.Type;

export const ProviderCatalogAddResult = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type ProviderCatalogAddResult = typeof ProviderCatalogAddResult.Type;

// ---------------------------------------------------------------------------
// Install state additions (SPEC 11.2). `ProviderInstallState` in providerSetup.ts
// takes these when release 2 is wired in; until then this file is the contract.
// ---------------------------------------------------------------------------

export const ProviderInstallFailureKind = Schema.Literals([
  "network",
  "checksum",
  "disk",
  "wontStart",
  "unsupported",
  "npm",
  "other",
]);
export type ProviderInstallFailureKind = typeof ProviderInstallFailureKind.Type;

/**
 * Why an install stopped, in fields the phone turns into one sentence. `detail`
 * is the provider's own first line (max 160 characters), never a stack trace,
 * URL query, token or path outside the install folder.
 */
export const ProviderInstallFailure = Schema.Struct({
  kind: ProviderInstallFailureKind,
  detail: Schema.String.check(Schema.isMaxLength(160)),
  neededBytes: Schema.optionalKey(ByteCount),
  freeBytes: Schema.optionalKey(ByteCount),
  /** Host of the failed download, without scheme, path or query. */
  host: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(255))),
});
export type ProviderInstallFailure = typeof ProviderInstallFailure.Type;

/** The phases a registry-agent install reports, in order. */
export const ProviderCatalogInstallPhase = Schema.Literals([
  "idle",
  "resolving",
  "downloading",
  "extracting",
  "verifying",
  "starting",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ProviderCatalogInstallPhase = typeof ProviderCatalogInstallPhase.Type;

/**
 * `ProviderInstallState` as release 2 extends it: two more phases, a typed
 * failure and the kept previous version. Field names and meanings for the
 * shared fields are unchanged.
 */
export const ProviderCatalogInstallState = Schema.Struct({
  catalogId: ProviderCatalogId,
  operationId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  phase: ProviderCatalogInstallPhase,
  downloadedBytes: ByteCount,
  totalBytes: Schema.NullOr(ByteCount),
  /** Version being installed, or the installed one when idle. */
  version: Schema.NullOr(TrimmedNonEmptyString),
  installedVersion: Schema.NullOr(TrimmedNonEmptyString),
  previousVersion: Schema.NullOr(TrimmedNonEmptyString),
  canRemove: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(ProviderInstallFailure),
});
export type ProviderCatalogInstallState = typeof ProviderCatalogInstallState.Type;

/** What the phone needs to render the install confirmation sheet (SPEC 5.2). */
export const ProviderCatalogInstallPlan = Schema.Struct({
  catalogId: ProviderCatalogId,
  version: Schema.String,
  distribution: ProviderCatalogDistribution,
  downloadBytes: Schema.NullOr(ByteCount),
  /** Free space the install needs before it starts (2.5 x the download). */
  requiredBytes: ByteCount,
  sha256Checked: Schema.Boolean,
  /** Host the download comes from, for the "where it comes from" line. */
  host: Schema.NullOr(Schema.String.check(Schema.isMaxLength(255))),
  runsInstallScripts: Schema.Boolean,
});
export type ProviderCatalogInstallPlan = typeof ProviderCatalogInstallPlan.Type;
