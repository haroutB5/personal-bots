import type { ServerProvider, ServerProviderModel } from "./server.ts";

/**
 * The models a bot must never *auto-pick*, on any provider and for any
 * automatic default (a new bot form, a provider switch, the fallback picker,
 * a seeded data root): Fable and Mythos are the most expensive Claude tiers,
 * and Astra is Codex's most expensive one, which the Codex catalog marks as
 * its default. All three stay pickable by hand.
 *
 * One rule for the whole app: the server seed used to own it
 * (`apps/server/src/personal/seedModel.ts`) while the bot form used the
 * provider's own `isDefault` - which is Fable on Claude and Astra on Codex -
 * so every new bot landed on the priciest model. Both now call this module.
 */
export const isExpensiveDefaultModel = (slug: string): boolean => /fable|mythos|astra/i.test(slug);

/** The default a new bot gets on Claude, at medium effort, when the provider lists it. */
export const PREFERRED_BOT_MODEL = "claude-opus-5-5";

/** The catalogue minus the auto-pick set, in the provider's own order. */
const affordableModels = (
  instance: Pick<ServerProvider, "models"> | undefined,
): ReadonlyArray<ServerProviderModel> =>
  (instance?.models ?? []).filter((model) => !isExpensiveDefaultModel(model.slug));

/** The provider's first current (non-legacy) model that may be auto-picked, else its first. */
const firstAffordable = (
  instance: Pick<ServerProvider, "models"> | undefined,
): ServerProviderModel | undefined => {
  const affordable = affordableModels(instance);
  return affordable.find((model) => model.isLegacy !== true) ?? affordable[0];
};

/**
 * The model a bot starts on when nobody picked one: Opus 5.5 when the
 * provider has it; else the provider's own default when that is not Fable,
 * Mythos or Astra; else - the provider recommends one we never auto-pick,
 * like Codex's Astra - its first current model. "" when the provider names no
 * default at all (OpenCode lists hundreds of models from many sub-providers,
 * some paid): the owner picks, rather than the form preselecting a model the
 * provider's own catalogue does not recommend.
 */
export function safeDefaultBotModelSlug(
  instance: Pick<ServerProvider, "models"> | undefined,
): string {
  const models = instance?.models ?? [];
  if (models.some((model) => model.slug === PREFERRED_BOT_MODEL)) return PREFERRED_BOT_MODEL;
  const named = models.find((model) => model.isDefault === true);
  if (named === undefined) return "";
  if (!isExpensiveDefaultModel(named.slug)) return named.slug;
  return firstAffordable(instance)?.slug ?? "";
}

/**
 * {@link safeDefaultBotModelSlug}, and never "": a fresh data root has to
 * seed its bots on something, so a provider with no usable default falls back
 * to its first current model (never onto an expensive one). "" only when the
 * provider lists nothing a bot may run on.
 */
export function firstSafeBotModelSlug(
  instance: Pick<ServerProvider, "models"> | undefined,
): string {
  const safe = safeDefaultBotModelSlug(instance);
  return safe === "" ? (firstAffordable(instance)?.slug ?? "") : safe;
}
