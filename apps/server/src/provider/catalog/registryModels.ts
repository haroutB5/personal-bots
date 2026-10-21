/**
 * Models a registry agent offers, read from its ACP session setup: the
 * `model` config option when it has one, else the older `models` state.
 *
 * @module provider/catalog/registryModels
 */
import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type * as EffectAcpSchema from "effect-acp/schema";

type SessionSetup = {
  readonly configOptions?: EffectAcpSchema.NewSessionResponse["configOptions"];
  readonly models?: EffectAcpSchema.NewSessionResponse["models"];
};

const NO_OPTIONS = createModelCapabilities({ optionDescriptors: [] });

interface ModelEntry {
  readonly value: string;
  readonly name: string;
}

function modelConfigOption(setup: SessionSetup) {
  return setup.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
}

/** Every model the agent offers, in its own order. */
export function registryModelEntries(setup: SessionSetup): ReadonlyArray<ModelEntry> {
  const config = modelConfigOption(setup);
  if (config?.type === "select") {
    return config.options.flatMap((entry): ModelEntry[] =>
      "value" in entry
        ? [{ value: entry.value, name: entry.name }]
        : entry.options.map((nested) => ({ value: nested.value, name: nested.name })),
    );
  }
  return (
    setup.models?.availableModels.map((model) => ({ value: model.modelId, name: model.name })) ?? []
  );
}

/** The model the agent starts on. */
export function registryCurrentModel(setup: SessionSetup): string | undefined {
  const config = modelConfigOption(setup);
  return config?.type === "select" ? config.currentValue : setup.models?.currentModelId;
}

/** Where a model change goes: the `model` config option, else `session/set_model`. */
export function registryModelSwitch(setup: SessionSetup): "config" | "session" | "none" {
  if (modelConfigOption(setup)?.type === "select") return "config";
  return setup.models !== undefined && setup.models !== null ? "session" : "none";
}

export function buildRegistryModels(setup: SessionSetup): ReadonlyArray<ServerProviderModel> {
  const current = registryCurrentModel(setup);
  const seen = new Set<string>();
  return registryModelEntries(setup).flatMap((entry): ServerProviderModel[] => {
    const slug = entry.value.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: entry.name.trim() ? entry.name : slug,
        isCustom: false,
        ...(slug === current ? { isDefault: true } : {}),
        capabilities: NO_OPTIONS,
      },
    ];
  });
}
