import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

/**
 * Pins the model of the default bots a fresh data root seeds. Test servers
 * set it (e.g. `claude-sonnet-5-5`) so their chats run on a cheap model; used
 * only when the provider lists that model.
 */
export const PERSONAL_SEED_MODEL_ENV = "PERSONAL_SEED_MODEL";

/** The seed's first choice on Claude, at medium effort. */
const PREFERRED_SEED_MODEL = "claude-opus-5-5";
const PREFERRED_SEED_EFFORT = "medium";

/**
 * Fable and Mythos are the most expensive models. The catalog marks Fable as
 * Claude's default, so every throwaway test root (and a fresh install) used
 * to seed its bots on it: 56 Fable requests in two days from e2e servers.
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
 * the provider has it; else Opus 5.5 at medium; else the provider's default,
 * then its first non-legacy model, skipping Fable and Mythos. Undefined:
 * the provider lists nothing else (never seed onto Fable or Mythos).
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
  if (slugs.includes(PREFERRED_SEED_MODEL)) return withMediumEffort(instance, PREFERRED_SEED_MODEL);
  const affordable = instance.models.filter((model) => !isExpensiveSeedModel(model.slug));
  const chosen =
    affordable.find((model) => model.isDefault === true) ??
    affordable.find((model) => model.isLegacy !== true) ??
    affordable[0];
  return chosen === undefined ? undefined : withMediumEffort(instance, chosen.slug);
}
