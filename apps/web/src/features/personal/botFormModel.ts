import type {
  SelectProviderOptionDescriptor,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { driverCarriesBotInstructions } from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";

import { getProviderModelCapabilities } from "~/providerModels";

import { resolveBotProvider } from "./botSummaries";

/**
 * Providers the form may offer for a new bot: ready to run, *and* running an
 * adapter that carries the bot's persona. On any other provider the bot's
 * name, its instructions and the app rules are dropped before the prompt
 * leaves the server, so offering it would create a bot that silently is not
 * the bot the owner wrote (see `BOT_INSTRUCTION_DRIVER_KINDS` in contracts).
 */
export function isBotProviderSelectable(provider: ServerProvider): boolean {
  return (
    resolveBotProvider(provider.instanceId, [provider]).available &&
    driverCarriesBotInstructions(provider.driver)
  );
}

/**
 * The editor's warning for a bot already saved on a provider that drops its
 * persona. The owner has none today, but an upstream provider change could
 * leave one behind, and it must not look normal. Null when the provider
 * carries instructions, or is unknown to this client.
 */
export function botInstructionSupportWarning(
  provider: ServerProvider | undefined,
  providerLabel: string,
): string | null {
  if (provider === undefined || driverCarriesBotInstructions(provider.driver)) return null;
  return `${providerLabel} does not pass bot instructions to the model. On this provider the bot replies as the plain model: it ignores its name, everything you write under Instructions, and the app rules for memory, passwords and browsing. Pick another provider from the list.`;
}

/**
 * What to say when the picker has nothing to offer. "No provider is ready"
 * would be a lie when one is running but cannot carry the bot's persona, so
 * that case gets its own line.
 */
export function noBotProviderMessage(providers: ReadonlyArray<ServerProvider>): string {
  const readyButMute = providers.some(
    (provider) =>
      resolveBotProvider(provider.instanceId, providers).available &&
      !driverCarriesBotInstructions(provider.driver),
  );
  return readyButMute
    ? "The providers ready on your computer don't pass bot instructions to the model, so a bot there would reply as the plain model. Set up Claude Code, Codex or OpenCode, then come back to create a bot."
    : "No provider is ready on your computer yet. Set up Claude Code or Codex there, then come back to create a bot.";
}

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
