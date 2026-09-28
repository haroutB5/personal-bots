import type {
  ModelSelection,
  SelectProviderOptionDescriptor,
  ServerProvider,
} from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "~/providerModels";

/** Claude calls the effort option `effort`, Codex `reasoningEffort`, OpenCode `variant`. */
export const EFFORT_OPTION_IDS: ReadonlyArray<string> = ["effort", "reasoningEffort", "variant"];

/**
 * The short model line beside a bot's name: "Opus 5.5 medium", "Sonnet 5",
 * "GPT-6 Astra medium". The model's name as the picker shows it, without the
 * "Claude" every Claude model repeats, plus the chosen effort (or OpenCode
 * variant) when one is set; a bot on the model's default effort shows none.
 * A model the provider does not list (not loaded yet, or retired) falls back
 * to its id, the only name there is. Null without a model.
 */
export function botModelLabel(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): string | null {
  const slug = selection.model.trim();
  if (slug === "") return null;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const model = provider?.models?.find((candidate) => candidate.slug === slug);
  const name = (model?.name.trim() || slug).replace(/^Claude\s+/, "");

  const effortId = EFFORT_OPTION_IDS.find(
    (id) => getModelSelectionStringOptionValue(selection, id) !== undefined,
  );
  const effort =
    effortId === undefined ? undefined : getModelSelectionStringOptionValue(selection, effortId);
  if (effort === undefined || effort.trim() === "") return name;
  const optionLabel =
    provider?.models === undefined
      ? undefined
      : getProviderOptionDescriptors({
          caps: getProviderModelCapabilities(provider.models, slug, provider.driver),
        })
          .find(
            (descriptor): descriptor is SelectProviderOptionDescriptor =>
              descriptor.type === "select" && descriptor.id === effortId,
          )
          ?.options.find((option) => option.id === effort)?.label;
  return `${name} ${(optionLabel ?? effort).toLocaleLowerCase()}`;
}
