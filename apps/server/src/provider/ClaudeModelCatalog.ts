import {
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
import { compareSemverVersions } from "@t3tools/shared/semver";

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

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

export interface ClaudeCatalogModel {
  readonly model: ServerProviderModel;
  readonly runtime: ClaudeCodeProfile;
  readonly compatibility: ClaudeCodeCompatibility;
}

export interface ClaudeModelCatalog {
  readonly models: ReadonlyArray<ClaudeCatalogModel>;
}

const CLAUDE_MODEL_SLUG = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*)$/;

export type ClaudeModelFamily = "opus" | "sonnet" | "haiku" | "fable";

export interface ParsedClaudeModelSlug {
  readonly family: ClaudeModelFamily;
  readonly version: ReadonlyArray<number>;
}

/** Dated release aliases are implementation details, not picker models. */
export function parseClaudeModelSlug(slug: string): ParsedClaudeModelSlug | undefined {
  const match = CLAUDE_MODEL_SLUG.exec(slug);
  if (!match) return undefined;
  const versionParts = match[2]!.split("-");
  if (versionParts.some((part) => part.length === 8)) return undefined;
  return {
    family: match[1]! as ClaudeModelFamily,
    version: versionParts.map(Number),
  };
}

export function formatClaudeModelName(slug: string): string | undefined {
  const parsed = parseClaudeModelSlug(slug);
  if (!parsed) return undefined;
  const family = parsed.family[0]!.toUpperCase() + parsed.family.slice(1);
  return `Claude ${family} ${parsed.version.join(".")}`;
}

function compareClaudeModelVersions(
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Add CLI-supported models without letting executable strings redefine
 * manifest presentation, defaults, or adapter behavior.
 */
export function mergeDiscoveredClaudeModels(
  catalog: ClaudeModelCatalog,
  discoveredSlugs: ReadonlySet<string> | ReadonlyArray<string>,
): ClaudeModelCatalog {
  const manifestSlugs = new Set(catalog.models.map((entry) => entry.model.slug));
  const profiles = new Map<ClaudeModelFamily, ClaudeCatalogModel>();
  for (const entry of catalog.models) {
    const parsed = parseClaudeModelSlug(entry.model.slug);
    if (!parsed) continue;
    // The newest of the family by version, not by manifest order: the profile
    // a new model inherits, and the bar it has to clear to be listed at all.
    const held = profiles.get(parsed.family);
    const heldVersion = held ? parseClaudeModelSlug(held.model.slug)?.version : undefined;
    if (!heldVersion || compareClaudeModelVersions(parsed.version, heldVersion) < 0) {
      profiles.set(parsed.family, entry);
    }
  }

  const extrasByFamily = new Map<ClaudeModelFamily, Array<ClaudeCatalogModel>>();
  for (const slug of new Set(discoveredSlugs)) {
    if (manifestSlugs.has(slug)) continue;
    const parsed = parseClaudeModelSlug(slug);
    if (!parsed) continue;
    const profile = profiles.get(parsed.family);
    const name = formatClaudeModelName(slug);
    if (!profile || !name) continue;
    // Only models NEWER than the family's newest manifest entry. A binary
    // carries every id it ever spoke to - retired generations, and stray
    // version-shaped strings - and the picker is not an archive. The point of
    // discovery is the model that shipped before the manifest caught up.
    const newest = parseClaudeModelSlug(profile.model.slug);
    if (!newest || compareClaudeModelVersions(parsed.version, newest.version) >= 0) continue;
    const extras = extrasByFamily.get(parsed.family) ?? [];
    extras.push({
      model: {
        slug,
        name,
        isCustom: false,
        capabilities: profile.model.capabilities,
      },
      runtime: profile.runtime,
      compatibility: {},
    });
    extrasByFamily.set(parsed.family, extras);
  }
  if (extrasByFamily.size === 0) return catalog;

  const emittedFamilies = new Set<ClaudeModelFamily>();
  const models: Array<ClaudeCatalogModel> = [];
  for (const entry of catalog.models) {
    const parsed = parseClaudeModelSlug(entry.model.slug);
    if (!parsed || !extrasByFamily.has(parsed.family)) {
      models.push(entry);
      continue;
    }
    if (emittedFamilies.has(parsed.family)) continue;
    emittedFamilies.add(parsed.family);
    models.push(
      ...catalog.models
        .filter((candidate) => parseClaudeModelSlug(candidate.model.slug)?.family === parsed.family)
        .concat(extrasByFamily.get(parsed.family)!)
        .toSorted((left, right) =>
          compareClaudeModelVersions(
            parseClaudeModelSlug(left.model.slug)!.version,
            parseClaudeModelSlug(right.model.slug)!.version,
          ),
        ),
    );
  }

  return { models };
}

function tryResolveClaudeModelCatalog(manifest: ModelManifestData): ClaudeModelCatalog | null {
  const resolved = resolveProviderCatalog(manifest, CLAUDE);
  if (!resolved) return null;

  const models: Array<ClaudeCatalogModel> = [];
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

  return {
    models,
  };
}

export function resolveClaudeModelCatalog(manifest: ModelManifestData): ClaudeModelCatalog {
  return (
    tryResolveClaudeModelCatalog(manifest) ??
    tryResolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST) ?? {
      models: [],
    }
  );
}

export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(BUNDLED_MODEL_MANIFEST);

/**
 * Scope the catalog to one instance's settings: custom model slugs stay opaque
 * (a built-in alias they shadow is dropped, canonical slugs and capabilities
 * are preserved), and custom entries that declare their own capabilities are
 * appended so the adapter resolves effort / fast mode / thinking against the
 * user's descriptors instead of the empty default. Custom entries carry no
 * runtime profile, so option values pass through to Claude Code verbatim.
 */
export function scopeClaudeModelCatalog(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): ClaudeModelCatalog {
  const customEntries = readCustomModelEntries(customModels);
  if (customEntries.length === 0) return catalog;
  const customAliases = new Set(customEntries.map((entry) => entry.slug.toLowerCase()));

  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {
      return entry;
    }
    return {
      ...entry,
      model: {
        ...entry.model,
        aliases: entry.model.aliases.filter((alias) => !customAliases.has(alias.toLowerCase())),
      },
    };
  });
  const builtInSlugs = new Set(builtInModels.map((entry) => entry.model.slug));
  const customCatalogModels: Array<ClaudeCatalogModel> = [];
  for (const entry of customEntries) {
    if (!entry.capabilities || builtInSlugs.has(entry.slug)) continue;
    customCatalogModels.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        isCustom: true,
        capabilities: entry.capabilities,
      },
      runtime: {},
      compatibility: {},
    });
  }

  return { models: [...builtInModels, ...customCatalogModels] };
}

function resolveClaudeCatalogModel(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ClaudeCatalogModel | undefined {
  const value = slugOrAlias?.trim();
  if (!value) return undefined;
  return (
    catalog.models.find((entry) => entry.model.slug === value) ??
    catalog.models.find((entry) =>
      entry.model.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()),
    )
  );
}

export function resolveClaudeModelSlug(catalog: ClaudeModelCatalog, slugOrAlias: string): string {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.slug ?? slugOrAlias;
}

export function getClaudeCatalogModelCapabilities(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ModelCapabilities {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.capabilities ?? EMPTY_CAPABILITIES;
}

function isVersionSupported(
  compatibility: ClaudeCodeCompatibility,
  version: string | null | undefined,
): boolean {
  if (!compatibility.minVersion && !compatibility.maxVersionExclusive) return true;
  if (!version) return false;
  if (compatibility.minVersion && compareSemverVersions(version, compatibility.minVersion) < 0) {
    return false;
  }
  return !(
    compatibility.maxVersionExclusive &&
    compareSemverVersions(version, compatibility.maxVersionExclusive) >= 0
  );
}

export function resolveClaudeModelsForVersion(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ClaudeCatalogModel["model"]> {
  return catalog.models
    .filter((entry) => isVersionSupported(entry.compatibility, version))
    .map((entry) => entry.model);
}

export function formatClaudeVersionUpgradeMessage(
  catalog: ClaudeModelCatalog,
  version: string | null,
): string | undefined {
  const unavailable = catalog.models
    .filter(
      (entry) =>
        entry.compatibility.minVersion &&
        (!version || compareSemverVersions(version, entry.compatibility.minVersion) < 0),
    )
    .toSorted((left, right) =>
      compareSemverVersions(left.compatibility.minVersion!, right.compatibility.minVersion!),
    )[0];
  if (!unavailable?.compatibility.minVersion) return undefined;
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for ${unavailable.model.name}. Upgrade to v${unavailable.compatibility.minVersion} or newer to access it.`;
}

export function resolveClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "effort");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;
  const effortMap = resolveClaudeCatalogModel(catalog, model)?.runtime.effortMap;
  if (!effortMap || !Object.prototype.hasOwnProperty.call(effortMap, effort)) return effort;
  return effortMap[effort] ?? undefined;
}

export function isClaudeCatalogUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

function resolveClaudeCatalogContextWindow(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeCatalogApiModelId(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection,
): string {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection.model);
  const slug = entry?.model.slug ?? modelSelection.model;
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

export function resolveClaudeCatalogContextWindowTokens(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): number | undefined {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection?.model);
  if (!entry) return undefined;
  if (entry.runtime.fixedContextWindowTokens) return entry.runtime.fixedContextWindowTokens;
  const contextWindow = resolveClaudeCatalogContextWindow(catalog, modelSelection);
  return contextWindow ? entry.runtime.contextWindowTokens?.[contextWindow] : undefined;
}
