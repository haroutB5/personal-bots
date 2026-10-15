import type {
  ModelSelection,
  PersonalBotFallback,
  PersonalBotFallbackInput,
  PersonalBotSchedule,
  PersonalBotScheduleInput,
  SelectProviderOptionDescriptor,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  botFallback,
  DEEPSEEK_AGENT_MODE_OPTION_ID,
  driverCarriesBotInstructions,
  PERSONAL_BOT_DEFAULT_FALLBACK_MODEL,
  safeDefaultBotModelSlug,
  scheduleMatchesOwnModel,
} from "@t3tools/contracts";
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
    ? "The providers ready on your computer don't pass bot instructions to the model, so a bot there would reply as the plain model. Set up Claude Code, Codex, OpenCode or DeepSeek, then come back to create a bot."
    : "No provider is ready on your computer yet. Set up Claude Code, Codex or DeepSeek there, then come back to create a bot.";
}

export { EFFORT_OPTION_IDS } from "./botModelLabel";
import { EFFORT_OPTION_IDS } from "./botModelLabel";

/**
 * The provider's own default model, or "" when it names none (OpenCode lists
 * hundreds of models from many sub-providers, some paid), so the owner picks.
 *
 * Fable, Mythos and Astra are never taken automatically: the provider's own
 * `isDefault` is Fable on Claude and Astra on Codex, the two priciest tiers,
 * so a new bot and a provider switch go through the shared rule the server
 * seed uses (`safeDefaultBotModelSlug` in contracts): Opus 5.5 first, then
 * the provider's default, then its first current model. All three stay
 * pickable by hand.
 */
export function defaultModelFor(provider: ServerProvider | undefined): string {
  return safeDefaultBotModelSlug(provider);
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

/** The option id the DeepSeek Harness engine uses for a bot's agent mode. */
export const AGENT_MODE_OPTION_ID = DEEPSEEK_AGENT_MODE_OPTION_ID;

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

/**
 * The selected model's agent mode control, if its provider offers one. Only a
 * DeepSeek bot on the DeepSeek Harness engine has it: on the Claude Code
 * engine the descriptor is absent and the form shows no picker.
 */
export function botAgentModeDescriptor(
  provider: ServerProvider | undefined,
  model: string,
): SelectProviderOptionDescriptor | null {
  return botSelectDescriptor(provider, model, [AGENT_MODE_OPTION_ID]);
}

/** The agent mode a model selection carries, or "" when it names none. */
export function agentModeOfSelection(selection: ModelSelection): string {
  return getModelSelectionStringOptionValue(selection, AGENT_MODE_OPTION_ID) ?? "";
}

/** The selected model's context window choice (e.g. 200k / 1M), if it offers more than one. */
export function botContextWindowDescriptor(
  provider: ServerProvider | undefined,
  model: string,
): SelectProviderOptionDescriptor | null {
  const descriptor = botSelectDescriptor(provider, model, [CONTEXT_WINDOW_OPTION_ID]);
  return descriptor !== null && descriptor.options.length > 1 ? descriptor : null;
}

/** A model choice as the form holds it: instance, model, effort, window and mode. */
export interface ModelDraft {
  readonly instanceId: string;
  readonly model: string;
  /** Effort option id; "" keeps the model's default. */
  readonly effort: string;
  /** Context window option id (e.g. "1m"); "" keeps the model's default. */
  readonly contextWindow: string;
  /** Agent mode option id ("standard" by default); "" keeps the model's default. */
  readonly agentMode: string;
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
    agentMode: agentModeOfSelection(selection),
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
  const agentModeDescriptor = botAgentModeDescriptor(provider, draft.model);
  const agentModeValue =
    agentModeDescriptor?.options.some((option) => option.id === draft.agentMode) === true
      ? draft.agentMode
      : "";
  const others = (start.options ?? []).filter(
    (option) =>
      !EFFORT_OPTION_IDS.includes(option.id) &&
      option.id !== CONTEXT_WINDOW_OPTION_ID &&
      option.id !== AGENT_MODE_OPTION_ID,
  );
  const options = [
    ...others,
    ...(effortDescriptor !== null && effortValue !== ""
      ? [{ id: effortDescriptor.id, value: effortValue }]
      : []),
    ...(contextWindowDescriptor !== null && contextWindowValue !== ""
      ? [{ id: contextWindowDescriptor.id, value: contextWindowValue }]
      : []),
    // The mode is written whenever the model offers one: a resumed session
    // keeps the mode it was started in, so the saved value is the mode the
    // next new chat gets.
    ...(agentModeDescriptor !== null && agentModeValue !== ""
      ? [{ id: agentModeDescriptor.id, value: agentModeValue }]
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

// --- the per-bot model schedule ("Use a different model at set times") ---------

/** What the schedule section of the bot form holds. */
export interface ScheduleDraft extends ModelDraft {
  readonly enabled: boolean;
  /** 24 hour "HH:MM", the laptop's local time. */
  readonly from: string;
  readonly to: string;
}

export const DEFAULT_SCHEDULE_FROM = "22:00";
export const DEFAULT_SCHEDULE_TO = "07:00";

/** Every 15 minutes of a day, "00:00" to "23:45": what the From and To pickers offer. */
export const SCHEDULE_TIME_OPTIONS: ReadonlyArray<string> = Array.from(
  { length: 96 },
  (_, index) => {
    const minutes = index * 15;
    const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
    const rest = String(minutes % 60).padStart(2, "0");
    return `${hours}:${rest}`;
  },
);

/** The schedule a bot has now; a new one starts off, 22:00 to 07:00, on Sonnet 5.5 High. */
export function scheduleDraftFromBot(
  bot: { readonly schedule?: PersonalBotSchedule } | null,
): ScheduleDraft {
  const saved = bot?.schedule;
  if (saved === undefined) {
    return {
      enabled: false,
      from: DEFAULT_SCHEDULE_FROM,
      to: DEFAULT_SCHEDULE_TO,
      ...modelDraftFromSelection(PERSONAL_BOT_DEFAULT_FALLBACK_MODEL),
    };
  }
  return {
    enabled: saved.enabled,
    from: saved.from,
    to: saved.to,
    ...modelDraftFromSelection(saved.modelSelection),
  };
}

/**
 * What stops a schedule that is on from being saved, in the owner's words, or
 * null. `main` is the bot's own model as the form would save it.
 */
export function scheduleDraftProblem(
  draft: ScheduleDraft,
  main: ModelSelection,
  scheduled: ModelSelection | null,
): string | null {
  if (!draft.enabled) return null;
  if (draft.from === draft.to) return "From and To can't be the same time.";
  if (scheduled === null) return "Pick a model for the scheduled time.";
  if (scheduleMatchesOwnModel(main, scheduled)) {
    return "Pick a different model from the bot's own, or a different effort.";
  }
  return null;
}

/** The scheduled model the draft stands for, or null while it has no provider or model. */
export function scheduleDraftSelection(
  draft: ScheduleDraft,
  providers: ReadonlyArray<ServerProvider>,
  saved: PersonalBotSchedule | null,
): ModelSelection | null {
  if (draft.instanceId === "" || draft.model === "") return null;
  return buildModelSelection(
    draft,
    providers.find((provider) => provider.instanceId === draft.instanceId),
    saved?.modelSelection ?? null,
  );
}

/**
 * What to send for the schedule: nothing for a bot that has none and keeps it
 * off; on create the whole schedule when it is on; on edit only what differs
 * from the saved one (the server lays it over what the bot has).
 */
export function scheduleInput(
  saved: PersonalBotSchedule | null,
  draft: ScheduleDraft,
  selection: ModelSelection | null,
): PersonalBotScheduleInput | undefined {
  if (saved === null && !draft.enabled) return undefined;
  if (saved === null) {
    if (selection === null) return undefined;
    return { enabled: true, from: draft.from, to: draft.to, modelSelection: selection };
  }
  const input: {
    enabled?: boolean;
    from?: string;
    to?: string;
    modelSelection?: ModelSelection;
  } = {};
  if (saved.enabled !== draft.enabled) input.enabled = draft.enabled;
  if (draft.enabled) {
    if (saved.from !== draft.from) input.from = draft.from;
    if (saved.to !== draft.to) input.to = draft.to;
    if (selection !== null && !modelSelectionsEqual(saved.modelSelection, selection)) {
      input.modelSelection = selection;
    }
  }
  return Object.keys(input).length === 0 ? undefined : input;
}

/** "Every day 22:00 to 07:00 this bot uses Sonnet 5.5 high": the one line that shows the result. */
export function scheduleHelpLine(
  draft: Pick<ScheduleDraft, "from" | "to">,
  modelLabel: string | null,
): string {
  return `Every day ${draft.from} to ${draft.to} this bot uses ${modelLabel ?? "the model you pick"}`;
}
