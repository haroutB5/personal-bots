/** DeepSeek's Flash-only catalog: manifest rows plus alias and scoping rules. */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
} from "@t3tools/shared/model";
import {
  catalogServerModel,
  type ProviderCatalog,
  type ProviderCatalogModel,
} from "@t3tools/provider-core/server/ModelCatalog";

/** Canonical DeepSeek Flash model id (DeepSeek-V4.1-Flash). */
export const DEEPSEEK_FLASH_MODEL = "deepseek-flash";

/** Documented legacy Flash aliases that route to V4.1-Flash at Flash price. */
export const DEEPSEEK_FLASH_ALIASES: ReadonlyArray<string> = ["deepseek-v4-flash", "vision-exp"];

/** Canonical Flash id. */
export const DEEPSEEK_FLASH_SLUG = DEEPSEEK_FLASH_MODEL;

const FLASH_ALIAS_SET = new Set(
  [DEEPSEEK_FLASH_MODEL, ...DEEPSEEK_FLASH_ALIASES].map((alias) => alias.toLowerCase()),
);

const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

/**
 * The Claude-shaped runtime fields the manifest's `claudeCode` profile adapter
 * carries. Only the two the picker and the API id read are modelled here.
 */
const DeepSeekRuntimeProfile = Schema.Struct({
  modelSuffixes: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
  fixedContextWindowTokens: Schema.optional(Schema.Number),
  contextWindowTokens: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
});
type DeepSeekRuntimeProfile = typeof DeepSeekRuntimeProfile.Type;

const DeepSeekProfileAdapter = Schema.Struct({
  claudeCode: Schema.optional(DeepSeekRuntimeProfile),
});
const decodeDeepSeekProfileAdapter = Schema.decodeUnknownOption(DeepSeekProfileAdapter);

export interface DeepSeekCatalogModel {
  readonly model: ServerProviderModel;
  readonly runtime: DeepSeekRuntimeProfile;
}

export interface DeepSeekModelCatalog {
  readonly models: ReadonlyArray<DeepSeekCatalogModel>;
}

/** True for the canonical Flash id or a documented Flash alias. */
export function isDeepSeekFlashId(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return false;
  if (FLASH_ALIAS_SET.has(normalized)) return true;
  // The `[1m]` context suffix is a runtime rendering, not a different model.
  return FLASH_ALIAS_SET.has(normalized.replace(/\[[^\]]*\]$/, ""));
}

/**
 * Canonicalize documented Flash aliases to `deepseek-flash`. Anything else
 * passes through untouched so the caller can reject it with a Flash-only
 * error instead of silently remapping an unrelated model.
 */
export function canonicalizeDeepSeekModelId(value: string): string {
  return isDeepSeekFlashId(value) ? DEEPSEEK_FLASH_MODEL : value;
}

/**
 * Turn the shared manifest catalog into DeepSeek's catalog. The manifest is
 * data; the only DeepSeek-specific step is decoding the Claude-shaped runtime
 * profile the manifest already stores beside each model.
 */
export function resolveDeepSeekModelCatalog(
  catalog: ProviderCatalog | undefined,
): DeepSeekModelCatalog {
  if (catalog === undefined) return { models: [] };
  const models: Array<DeepSeekCatalogModel> = catalog.models.map((entry: ProviderCatalogModel) => {
    const decoded = decodeDeepSeekProfileAdapter(entry.profileAdapter ?? {});
    return {
      model: catalogServerModel(catalog, entry),
      runtime: Option.isSome(decoded) ? (decoded.value.claudeCode ?? {}) : {},
    };
  });
  return { models };
}

/**
 * Scope the catalog to one instance's settings. Flash-only: custom entries
 * that are not the Flash id (or a documented Flash alias) are dropped, so a
 * stray Pro or Claude id can never enter the picker or the adapter. A custom
 * entry that shadows a built-in Flash alias drops that alias.
 */
export function scopeDeepSeekModelCatalog(
  catalog: DeepSeekModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): DeepSeekModelCatalog {
  const customEntries = readCustomModelEntries(customModels);
  if (customEntries.length === 0) return catalog;
  const flashShadows = new Set(
    customEntries
      .filter((entry) => isDeepSeekFlashId(entry.slug))
      .flatMap((entry) => [entry.slug.toLowerCase()]),
  );

  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => flashShadows.has(alias.toLowerCase()))) {
      return entry;
    }
    return {
      ...entry,
      model: {
        ...entry.model,
        aliases: entry.model.aliases.filter((alias) => !flashShadows.has(alias.toLowerCase())),
      },
    };
  });
  // Non-Flash custom models are intentionally not appended.
  return { models: builtInModels };
}

function resolveDeepSeekCatalogModel(
  catalog: DeepSeekModelCatalog,
  slugOrAlias: string | null | undefined,
): DeepSeekCatalogModel | undefined {
  const value = slugOrAlias?.trim();
  if (!value) return undefined;
  const canonical = canonicalizeDeepSeekModelId(value);
  return (
    catalog.models.find((entry) => entry.model.slug === canonical) ??
    catalog.models.find((entry) => entry.model.slug.toLowerCase() === canonical.toLowerCase()) ??
    catalog.models.find((entry) =>
      entry.model.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()),
    )
  );
}

/** Whether the catalog lists this model (canonical id or documented alias). */
export function deepSeekCatalogHasModel(catalog: DeepSeekModelCatalog, slug: string): boolean {
  return resolveDeepSeekCatalogModel(catalog, slug) !== undefined;
}

export function resolveDeepSeekModelSlug(
  catalog: DeepSeekModelCatalog,
  slugOrAlias: string,
): string {
  return resolveDeepSeekCatalogModel(catalog, slugOrAlias)?.model.slug ?? slugOrAlias;
}

export function getDeepSeekCatalogModelCapabilities(
  catalog: DeepSeekModelCatalog,
  slugOrAlias: string | null | undefined,
): ModelCapabilities {
  return (
    resolveDeepSeekCatalogModel(catalog, slugOrAlias)?.model.capabilities ?? EMPTY_CAPABILITIES
  );
}

export function resolveDeepSeekCatalogEffort(
  catalog: DeepSeekModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  const caps = getDeepSeekCatalogModelCapabilities(catalog, model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "effort");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveDeepSeekCatalogApiModelId(
  catalog: DeepSeekModelCatalog,
  modelSelection: ModelSelection,
): string {
  const entry = resolveDeepSeekCatalogModel(catalog, modelSelection.model);
  const slug = entry?.model.slug ?? canonicalizeDeepSeekModelId(modelSelection.model);
  const descriptors = getProviderOptionDescriptors({
    caps: entry?.model.capabilities ?? EMPTY_CAPABILITIES,
    ...(modelSelection.options === undefined ? {} : { selections: modelSelection.options }),
  });
  for (const [optionId, suffixes] of Object.entries(entry?.runtime.modelSuffixes ?? {})) {
    const value = getProviderOptionCurrentValue(
      descriptors.find((descriptor) => descriptor.id === optionId),
    );
    if (typeof value === "string" && suffixes[value]) return `${slug}${suffixes[value]}`;
  }
  return slug;
}

export function resolveDeepSeekCatalogContextWindowTokens(
  catalog: DeepSeekModelCatalog,
  modelSelection: ModelSelection | undefined,
): number | undefined {
  const entry = resolveDeepSeekCatalogModel(catalog, modelSelection?.model);
  if (!entry) return undefined;
  if (entry.runtime.fixedContextWindowTokens) return entry.runtime.fixedContextWindowTokens;
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps: entry.model.capabilities ?? EMPTY_CAPABILITIES,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? entry.runtime.contextWindowTokens?.[value] : undefined;
}
