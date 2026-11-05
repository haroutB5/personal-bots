import type { ServerProvider } from "@t3tools/contracts";

import { modelOptionLabel, searchModels } from "./botFormModel.ts";
import {
  filterModelsByPlan,
  offersModelPlanFilter,
  type ModelPlanFilter,
} from "./modelPlanFilter.ts";

export interface ModelSearchView {
  readonly showPlanFilter: boolean;
  readonly results: ReadonlyArray<ServerProvider["models"][number]>;
  readonly placeholder: string;
  readonly summary: string;
}

/**
 * What the type-to-search model field shows: browsing lists every model of the
 * chosen plan, typing narrows the same list, and the line under it says which.
 */
export function modelSearchView(input: {
  readonly models: ServerProvider["models"];
  readonly value: string;
  readonly query: string;
  readonly open: boolean;
  readonly planFilter: ModelPlanFilter;
}): ModelSearchView {
  const selected = input.models.find((model) => model.slug === input.value);
  const showPlanFilter = offersModelPlanFilter(input.models);
  const planned = filterModelsByPlan(input.models, showPlanFilter ? input.planFilter : "all");
  const trimmed = input.query.trim();
  const results = !input.open
    ? []
    : trimmed.length === 0
      ? planned
      : searchModels(planned, trimmed, 80);
  const summary =
    trimmed.length > 0
      ? results.length === 0
        ? `No models match "${trimmed}".`
        : `${results.length} matching`
      : selected === undefined
        ? `${planned.length} models. Pick one, or type to narrow the list.`
        : `Selected: ${modelOptionLabel(selected)}`;
  return {
    showPlanFilter,
    results,
    placeholder: selected === undefined ? "Search models" : modelOptionLabel(selected),
    summary,
  };
}
