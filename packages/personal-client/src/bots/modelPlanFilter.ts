/**
 * OpenCode 2 lists both the models included in the Go subscription
 * (`opencode-go/…`) and the ones paid per use through the API (`opencode/…`)
 * side by side, which is dozens of rows with no way to tell the plans apart at
 * a glance. These helpers divide that one catalogue so the pickers can offer
 * All / Go sub / API PAYG. Any other provider's models belong to no plan.
 */
export type ModelPlan = "go" | "payg";
export type ModelPlanFilter = "all" | ModelPlan;

export interface ModelPlanLike {
  readonly slug: string;
  readonly subProvider?: string | undefined;
}

export const MODEL_PLAN_FILTER_OPTIONS: ReadonlyArray<{
  readonly id: ModelPlanFilter;
  readonly label: string;
}> = [
  { id: "all", label: "All" },
  { id: "go", label: "Go sub" },
  { id: "payg", label: "API PAYG" },
];

export function modelPlanOf(model: ModelPlanLike): ModelPlan | null {
  if (model.slug.startsWith("opencode-go/") || model.subProvider === "OpenCode Go") return "go";
  if (model.slug.startsWith("opencode/") || model.subProvider === "OpenCode") return "payg";
  return null;
}

/** True only where both plans are on offer, so other providers never grow a chip row. */
export function offersModelPlanFilter(models: ReadonlyArray<ModelPlanLike>): boolean {
  let go = false;
  let payg = false;
  for (const model of models) {
    const plan = modelPlanOf(model);
    if (plan === "go") go = true;
    else if (plan === "payg") payg = true;
    if (go && payg) return true;
  }
  return false;
}

export function filterModelsByPlan<M extends ModelPlanLike>(
  models: ReadonlyArray<M>,
  filter: ModelPlanFilter,
): ReadonlyArray<M> {
  if (filter === "all") return models;
  return models.filter((model) => modelPlanOf(model) === filter);
}
