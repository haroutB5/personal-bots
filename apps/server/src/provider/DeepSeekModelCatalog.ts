/**
 * DeepSeekModelCatalog — Flash-only model catalog for the `deepseek` driver.
 *
 * The `deepseek` driver reuses the Claude Agent SDK runtime against DeepSeek's
 * Anthropic-compatible endpoint, so the catalog reuses the same manifest
 * profile/adapter shapes (`ClaudeCodeProfile`, `ClaudeCodeCompatibility`).
 * Only the model set differs: exactly one model, `deepseek-flash`
 * (DeepSeek-V4.1-Flash), with the documented legacy aliases canonicalized to
 * it. Pro (`deepseek-v4-pro`) and Claude (`claude-*`) ids are never accepted.
 *
 * @module provider/DeepSeekModelCatalog
 */
import {
  DEEPSEEK_FLASH_ALIASES,
  DEEPSEEK_FLASH_MODEL,
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
} from "@t3tools/shared/model";

import {
  type ClaudeCodeCompatibility,
  type ClaudeCodeProfile,
  decodeClaudeModelAdapter,
  decodeClaudeProfileAdapter,
} from "./ClaudeModelManifest.ts";
import {
  BUNDLED_MODEL_MANIFEST,
  type ModelManifestData,
  resolveProviderCatalog,
} from "./ModelManifest.ts";

const DEEPSEEK = ProviderDriverKind.make("deepseek");
const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

export interface DeepSeekCatalogModel {
  readonly model: ServerProviderModel;
  readonly runtime: ClaudeCodeProfile;
  readonly compatibility: ClaudeCodeCompatibility;
}

export interface DeepSeekModelCatalog {
  readonly models: ReadonlyArray<DeepSeekCatalogModel>;
}

/** Canonical Flash id. */
export const DEEPSEEK_FLASH_SLUG = DEEPSEEK_FLASH_MODEL;

/** Documented legacy Flash aliases, canonicalized to `deepseek-flash`. */
const FLASH_ALIAS_SET = new Set(
  [DEEPSEEK_FLASH_MODEL, ...DEEPSEEK_FLASH_ALIASES].map((alias) => alias.toLowerCase()),
);

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

function tryResolveDeepSeekModelCatalog(manifest: ModelManifestData): DeepSeekModelCatalog | null {
  const resolved = resolveProviderCatalog(manifest, DEEPSEEK);
  if (!resolved) return null;

  const models: Array<DeepSeekCatalogModel> = [];
  for (const entry of resolved.models) {
    const profile = decodeClaudeProfileAdapter(entry.profileAdapter ?? {});
    const adapter = decodeClaudeModelAdapter(entry.adapter ?? {});
    if (Option.isNone(profile) || Option.isNone(adapter)) return null;
    models.push({
      model: entry.model,
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
    });
  }

  return { models };
}

export function resolveDeepSeekModelCatalog(manifest: ModelManifestData): DeepSeekModelCatalog {
  return (
    tryResolveDeepSeekModelCatalog(manifest) ??
    tryResolveDeepSeekModelCatalog(BUNDLED_MODEL_MANIFEST) ?? {
      models: [],
    }
  );
}

export const BUNDLED_DEEPSEEK_MODEL_CATALOG = resolveDeepSeekModelCatalog(BUNDLED_MODEL_MANIFEST);

/**
 * Scope the catalog to one instance's settings. Flash-only: custom entries
 * that are not the Flash id (or a documented Flash alias) are dropped, so a
 * stray Pro or Claude id can never enter the picker or the adapter. A custom
 * entry that shadows a built-in Flash alias drops that alias, mirroring the
 * Claude scoping rule.
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
    selections: modelSelection.options,
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
    caps: getDeepSeekCatalogModelCapabilities(catalog, modelSelection?.model),
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? entry.runtime.contextWindowTokens?.[value] : undefined;
}
