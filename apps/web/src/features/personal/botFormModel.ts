import type {
  ModelSelection,
  PersonalBotFallback,
  PersonalBotFallbackInput,
  SelectProviderOptionDescriptor,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { botFallback, driverCarriesBotInstructions } from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

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

export { EFFORT_OPTION_IDS } from "./botModelLabel";
import { EFFORT_OPTION_IDS } from "./botModelLabel";

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

/** The option id every provider uses for its context window size choice. */
export const CONTEXT_WINDOW_OPTION_ID = "contextWindow";

function botSelectDescriptor(
  provider: ServerProvider | undefined,
  model: string,
  ids: ReadonlyArray<string>,
): SelectProviderOptionDescriptor | null {
  if (provider === undefined || model === "") return null;
  return (
    getProviderOptionDescriptors({
      caps: getProviderModelCapabilities(provider.models, model, provider.driver),
    }).find(
      (descriptor): descriptor is SelectProviderOptionDescriptor =>
        descriptor.type === "select" && ids.includes(descriptor.id),
    ) ?? null
  );
}

/** The selected model's effort control, if its provider offers one. */
export function botEffortDescriptor(
  provider: ServerProvider | undefined,
  model: string,
): SelectProviderOptionDescriptor | null {
  return botSelectDescriptor(provider, model, EFFORT_OPTION_IDS);
}

/** The selected model's context window choice (e.g. 200k / 1M), if it offers more than one. */
export function botContextWindowDescriptor(
  provider: ServerProvider | undefined,
  model: string,
): SelectProviderOptionDescriptor | null {
  const descriptor = botSelectDescriptor(provider, model, [CONTEXT_WINDOW_OPTION_ID]);
  return descriptor !== null && descriptor.options.length > 1 ? descriptor : null;
}

/** A model choice as the form holds it: provider instance, model, effort and context window. */
export interface ModelDraft {
  readonly instanceId: string;
  readonly model: string;
  /** Effort option id; "" keeps the model's default. */
  readonly effort: string;
  /** Context window option id (e.g. "1m"); "" keeps the model's default. */
  readonly contextWindow: string;
}

/** The choice a saved selection stands for. */
export function modelDraftFromSelection(selection: ModelSelection): ModelDraft {
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    effort:
      EFFORT_OPTION_IDS.map((id) => getModelSelectionStringOptionValue(selection, id)).find(
        (value) => value !== undefined,
      ) ?? "",
    contextWindow: getModelSelectionStringOptionValue(selection, CONTEXT_WINDOW_OPTION_ID) ?? "",
  };
}

/**
 * The selection a model choice saves as. An effort or context window the
 * model does not offer is dropped (the form shows the model's default then).
 * Options the form has no control for survive from `base` while the provider
 * instance and the model are the ones `base` already has. A provider this
 * client cannot see (not loaded, or gone) says nothing about the options, so
 * an untouched choice keeps `base` whole.
 */
export function buildModelSelection(
  draft: ModelDraft,
  provider: ServerProvider | undefined,
  base: ModelSelection | null,
): ModelSelection {
  const unchanged =
    base !== null && base.instanceId === draft.instanceId && base.model === draft.model;
  if (unchanged && provider === undefined) return base;
  const start = unchanged
    ? base
    : ({ instanceId: draft.instanceId, model: draft.model } as ModelSelection);
  const effortDescriptor = botEffortDescriptor(provider, draft.model);
  const effortValue =
    effortDescriptor?.options.some((option) => option.id === draft.effort) === true
      ? draft.effort
      : "";
  const contextWindowDescriptor = botContextWindowDescriptor(provider, draft.model);
  const contextWindowValue =
    contextWindowDescriptor?.options.some((option) => option.id === draft.contextWindow) === true
      ? draft.contextWindow
      : "";
  const others = (start.options ?? []).filter(
    (option) => !EFFORT_OPTION_IDS.includes(option.id) && option.id !== CONTEXT_WINDOW_OPTION_ID,
  );
  const options = [
    ...others,
    ...(effortDescriptor !== null && effortValue !== ""
      ? [{ id: effortDescriptor.id, value: effortValue }]
      : []),
    ...(contextWindowDescriptor !== null && contextWindowValue !== ""
      ? [{ id: contextWindowDescriptor.id, value: contextWindowValue }]
      : []),
  ];
  const { options: _previous, ...rest } = start;
  return (options.length > 0 ? { ...rest, options } : rest) as ModelSelection;
}

/** Same provider instance, model and options (in any order). */
export function modelSelectionsEqual(left: ModelSelection, right: ModelSelection): boolean {
  if (left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const key = (selection: ModelSelection) =>
    JSON.stringify(
      (selection.options ?? [])
        .map((option) => [option.id, option.value] as const)
        .toSorted(([a], [b]) => a.localeCompare(b)),
    );
  return key(left) === key(right);
}

/** What the fallback section of the bot form holds. */
export interface FallbackDraft extends ModelDraft {
  readonly enabled: boolean;
}

/** The fallback a bot has now (the default one for a bot or server that never set it). */
export function fallbackDraftFromBot(
  bot: { readonly fallback?: PersonalBotFallback } | null,
): FallbackDraft {
  const { enabled, modelSelection } = botFallback(bot ?? {});
  return { enabled, ...modelDraftFromSelection(modelSelection) };
}

/** A fallback that is on needs a provider and a model to switch to. */
export function isFallbackDraftValid(draft: FallbackDraft): boolean {
  return !draft.enabled || (draft.instanceId !== "" && draft.model !== "");
}

/**
 * What to send for the fallback: on create, the whole choice; on edit, only
 * what differs from the saved one, and nothing when nothing changed. A fallback
 * that is off sends no model when none is picked.
 */
export function fallbackInput(
  saved: PersonalBotFallback | null,
  draft: FallbackDraft,
  providers: ReadonlyArray<ServerProvider>,
): PersonalBotFallbackInput | undefined {
  const selection =
    draft.instanceId === "" || draft.model === ""
      ? null
      : buildModelSelection(
          draft,
          providers.find((provider) => provider.instanceId === draft.instanceId),
          saved?.modelSelection ?? null,
        );
  const input: { enabled?: boolean; modelSelection?: ModelSelection } = {};
  if (saved === null || saved.enabled !== draft.enabled) input.enabled = draft.enabled;
  if (
    selection !== null &&
    (saved === null || !modelSelectionsEqual(saved.modelSelection, selection))
  ) {
    input.modelSelection = selection;
  }
  return Object.keys(input).length === 0 ? undefined : input;
}

/**
 * The model's family: its id without version numbers and the context suffix,
 * so "claude-sonnet-5-5" and "claude-sonnet-5" are both "claude-sonnet" and
 * "gpt-5.5-codex" is "gpt-codex".
 */
function modelFamily(slug: string): string {
  return slug
    .toLocaleLowerCase()
    .replace(/\[[^\]]*\]/g, "")
    .split(/[-_/\s]+/)
    .filter((part) => part !== "" && !/^v?\d+(?:\.\d+)*[km]?$/.test(part))
    .join("-");
}

export const SAME_FAMILY_FALLBACK_HINT =
  "Same provider as the main model: it only helps for a model-specific limit.";

/**
 * The muted hint for a fallback on the main model's provider instance and model
 * family. A plan-wide limit hits both, so it helps only for a limit that is
 * specific to one model. Null for anything else; it never blocks saving.
 */
export function sameFamilyFallbackHint(
  main: Pick<ModelDraft, "instanceId" | "model">,
  fallback: Pick<ModelDraft, "instanceId" | "model">,
): string | null {
  if (main.instanceId === "" || main.model === "" || fallback.model === "") return null;
  if (main.instanceId !== fallback.instanceId) return null;
  return modelFamily(main.model) === modelFamily(fallback.model) ? SAME_FAMILY_FALLBACK_HINT : null;
}
