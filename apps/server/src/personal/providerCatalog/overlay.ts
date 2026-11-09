/**
 * The catalogue overlay: what the ACP registry does not say. Cost labels, the
 * sign-in label, the Popular order and hidden entries live here so a price or
 * ordering change does not need a release.
 *
 * @module personal/providerCatalog/overlay
 */
import { ProviderCatalogCostKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import bundledOverlayJson from "./provider-catalog-overlay.json" with { type: "json" };

const Text = Schema.String.check(Schema.isMaxLength(2_000));
const Label = Schema.String.check(Schema.isMaxLength(200));

const OverlayCost = Schema.Struct({
  kind: ProviderCatalogCostKind,
  label: Label,
  detail: Schema.optionalKey(Schema.NullOr(Text)),
});

const OverlayEntrySchema = Schema.Struct({
  publisher: Schema.optionalKey(Label),
  description: Schema.optionalKey(Text),
  cost: Schema.optionalKey(OverlayCost),
  signInLabel: Schema.optionalKey(Label),
  popularRank: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  hidden: Schema.optionalKey(Schema.Boolean),
});

const OverlaySchema = Schema.Struct({
  version: Schema.Literal(1),
  updatedAt: Schema.optionalKey(Schema.String),
  entries: Schema.Record(Schema.String, OverlayEntrySchema),
});

export type ProviderCatalogOverlay = typeof OverlaySchema.Type;
export type ProviderCatalogOverlayEntry = typeof OverlayEntrySchema.Type;

const decodeOverlay = Schema.decodeUnknownOption(OverlaySchema);

export const BUNDLED_PROVIDER_CATALOG_OVERLAY: ProviderCatalogOverlay =
  Schema.decodeUnknownSync(OverlaySchema)(bundledOverlayJson);

/** A malformed overlay is dropped whole; the caller keeps the bundled one. */
export function parseProviderCatalogOverlay(json: unknown): ProviderCatalogOverlay | null {
  const decoded = decodeOverlay(json);
  return Option.isSome(decoded) ? decoded.value : null;
}
