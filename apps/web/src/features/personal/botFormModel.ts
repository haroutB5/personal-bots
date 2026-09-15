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
