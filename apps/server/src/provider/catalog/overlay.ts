/**
 * The catalogue overlay: what the ACP registry does not say. Cost labels,
 * sign-in labels, the Popular order and hidden entries, plus the sign-in
 * presets release 3 reads (API key page, environment, recommended method).
 *
 * A bundled copy (`provider-catalog-overlay.json`) ships with every release.
 * A newer copy fetched from a configured address is cached on disk and wins
 * when its `updatedAt` is newer, so a price label can change without a release.
 *
 * @module provider/catalog/overlay
 */
import { ProviderCatalogCostKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import bundledOverlayJson from "./provider-catalog-overlay.json" with { type: "json" };

const Text = Schema.String.check(Schema.isMaxLength(2_000));
const Label = Schema.String.check(Schema.isMaxLength(200));
const HttpsUrl = Schema.String.check(Schema.isPattern(/^https:\/\/[^\s]+$/u));
const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/u));

const OverlayCost = Schema.Struct({
  kind: ProviderCatalogCostKind,
  label: Label,
  detail: Schema.optionalKey(Schema.NullOr(Text)),
});

const OverlayApiKey = Schema.Struct({
  /** Environment variable the agent reads the key from. */
  env: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,63}$/u)),
  keyPageUrl: Schema.optionalKey(HttpsUrl),
  checkUrl: Schema.optionalKey(HttpsUrl),
});

const OverlayEntrySchema = Schema.Struct({
  publisher: Schema.optionalKey(Label),
  description: Schema.optionalKey(Text),
  cost: Schema.optionalKey(OverlayCost),
  signInLabel: Schema.optionalKey(Label),
  popularRank: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  hidden: Schema.optionalKey(Schema.Boolean),
  recommendedMethod: Schema.optionalKey(Label),
  apiKey: Schema.optionalKey(OverlayApiKey),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /**
   * Archive fingerprints the team checked by hand, for versions the registry
   * lists without a sha256: `{ "1.4.1": { "windows-x86_64": "<64 hex>" } }`.
   * The pin applies to exactly that version and platform; a registry sha256
   * for the same archive always wins.
   */
  sha256Pins: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Sha256Hex)),
  ),
});

const OverlaySchema = Schema.Struct({
  version: Schema.Literal(1),
  /** ISO date of the last edit. A cached remote copy older than the bundle is ignored. */
  updatedAt: Schema.optionalKey(Schema.String),
  entries: Schema.Record(Schema.String, OverlayEntrySchema),
});

export type CatalogOverlay = typeof OverlaySchema.Type;
export type CatalogOverlayEntry = typeof OverlayEntrySchema.Type;

const decodeOverlay = Schema.decodeUnknownOption(OverlaySchema);

export const BUNDLED_CATALOG_OVERLAY: CatalogOverlay =
  Schema.decodeUnknownSync(OverlaySchema)(bundledOverlayJson);

/** An overlay that fails to decode is dropped whole; the caller keeps its bundled one. */
export function parseOverlay(json: unknown): CatalogOverlay | null {
  const decoded = decodeOverlay(json);
  return Option.isSome(decoded) ? decoded.value : null;
}

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export function parseOverlayText(text: string): CatalogOverlay | null {
  const json = decodeJsonText(text);
  return Option.isSome(json) ? parseOverlay(json.value) : null;
}

const updatedAtMs = (overlay: CatalogOverlay): number => {
  const parsed = overlay.updatedAt === undefined ? Number.NaN : Date.parse(overlay.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** The newer of two overlays by `updatedAt`; a tie keeps the bundled one. */
export function newerOverlay(
  bundled: CatalogOverlay,
  cached: CatalogOverlay | null,
): CatalogOverlay {
  return cached !== null && updatedAtMs(cached) > updatedAtMs(bundled) ? cached : bundled;
}
