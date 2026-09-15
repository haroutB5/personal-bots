import type {
  SelectProviderOptionDescriptor,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "~/providerModels";

/** Claude calls the effort option `effort`, Codex `reasoningEffort`, OpenCode `variant`. */
export const EFFORT_OPTION_IDS: ReadonlyArray<string> = ["effort", "reasoningEffort", "variant"];

/**
 * The provider's own default model, or "" when it names none (OpenCode lists
 * hundreds of models from many sub-providers, some paid), so the owner picks.
 */
export function defaultModelFor(provider: ServerProvider | undefined): string {
  return provider?.models.find((model) => model.isDefault && !model.isCustom)?.slug ?? "";
}

/** "Muse Spark 1.3 · OpenCode Zen": the sub-provider tells same-named models apart. */
export function modelOptionLabel(model: Pick<ServerProviderModel, "name" | "subProvider">): string {
  return model.subProvider ? `${model.name} · ${model.subProvider}` : model.name;
}

/** Past this many models a native picker is unusable on a phone; type to search instead. */
export const MODEL_SEARCH_THRESHOLD = 20;

export function usesModelSearch(models: ReadonlyArray<unknown>): boolean {
  return models.length > MODEL_SEARCH_THRESHOLD;
}

/**
 * Models matching every typed word (name, sub-provider or slug, any case).
 * Names that start with the first word come first; otherwise catalogue order.
 */
export function searchModels<M extends Pick<ServerProviderModel, "slug" | "name" | "subProvider">>(
  models: ReadonlyArray<M>,
  query: string,
  limit = 8,
): M[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (first === undefined) return [];
  const leading: M[] = [];
  const others: M[] = [];
  for (const model of models) {
    const haystack = `${model.name} ${model.subProvider ?? ""} ${model.slug}`.toLocaleLowerCase();
    if (!tokens.every((token) => haystack.includes(token))) continue;
    (model.name.toLocaleLowerCase().startsWith(first) ? leading : others).push(model);
  }
  return [...leading, ...others].slice(0, limit);
}

/** The selected model's effort control, if its provider offers one. */
export function botEffortDescriptor(
  provider: ServerProvider | undefined,
  model: string,
): SelectProviderOptionDescriptor | null {
  if (provider === undefined || model === "") return null;
  return (
    getProviderOptionDescriptors({
      caps: getProviderModelCapabilities(provider.models, model, provider.driver),
    }).find(
      (descriptor): descriptor is SelectProviderOptionDescriptor =>
        descriptor.type === "select" && EFFORT_OPTION_IDS.includes(descriptor.id),
    ) ?? null
  );
}
