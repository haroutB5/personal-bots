import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import { firstSafeBotModelSlug } from "@t3tools/contracts";

/**
 * Pins the model of the default bots a fresh data root seeds. Test servers
 * set it (e.g. `claude-sonnet-5-5`) so their chats run on a cheap model; used
 * only when the provider lists that model.
 */
export const PERSONAL_SEED_MODEL_ENV = "PERSONAL_SEED_MODEL";

const PREFERRED_SEED_EFFORT = "medium";

/**
 * Fable and Mythos are the most expensive models. The catalog marks Fable as
 * Claude's default, so every throwaway test root (and a fresh install) used
 * to seed its bots on it: 56 Fable requests in two days from e2e servers.
 *
 * The seed's own never-auto-pick set. The bot form's default (which also
 * skips Codex's Astra) is the wider `isExpensiveDefaultModel` in contracts;
 * here the set is deliberately unchanged, because the memory tidy-up's env
 * override reads this one and a pinned Astra tidy is the owner's own call.
 */
export const isExpensiveSeedModel = (slug: string): boolean => /fable|mythos/i.test(slug);

type SeedModel = Pick<ModelSelection, "model"> & { readonly options?: ModelSelection["options"] };

/** Medium effort when the model offers it, else no options. */
function withMediumEffort(instance: ServerProvider, slug: string): SeedModel {
  const model = instance.models.find((candidate) => candidate.slug === slug);
  const effort = model?.capabilities?.optionDescriptors?.find(
    (descriptor) => descriptor.id === "effort" && descriptor.type === "select",
  );
  const offersMedium =
    effort !== undefined &&
    effort.type === "select" &&
    effort.options.some((option) => option.id === PREFERRED_SEED_EFFORT);
  return offersMedium
    ? ({ model: slug, options: [{ id: "effort", value: PREFERRED_SEED_EFFORT }] } as SeedModel)
    : { model: slug };
}

/**
 * The model a seeded bot starts on: the `PERSONAL_SEED_MODEL` override when
 * the provider has it; else the shared safe default (`firstSafeBotModelSlug`
 * in contracts: Opus 5.5 first, the provider's own default next, skipping
 * Fable, Mythos and Astra) at medium effort. Undefined: the provider lists
 * nothing else (never seed onto an expensive model).
 */
export function seedModelFor(
  instance: ServerProvider,
  override: string | undefined,
): SeedModel | undefined {
  const slugs = instance.models.map((model) => model.slug);
  const pinned = override?.trim();
  if (pinned !== undefined && pinned.length > 0 && slugs.includes(pinned)) {
    return withMediumEffort(instance, pinned);
  }
  const chosen = firstSafeBotModelSlug(instance);
  return chosen === "" ? undefined : withMediumEffort(instance, chosen);
}
