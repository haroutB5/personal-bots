import type { JSX } from "react";

import { cn } from "~/lib/utils";

import { MODEL_PLAN_FILTER_OPTIONS, type ModelPlanFilter } from "./modelPlanFilter";

/**
 * All / Go sub / API PAYG for an OpenCode 2 model list. Only rendered where the
 * chosen instance offers both plans; other providers never see it.
 */
export function ModelPlanFilterChips({
  value,
  onChange,
  className,
}: {
  readonly value: ModelPlanFilter;
  readonly onChange: (value: ModelPlanFilter) => void;
  readonly className?: string;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Model plan"
      data-testid="model-plan-filter"
      className={cn("flex items-center gap-1", className)}
    >
      {MODEL_PLAN_FILTER_OPTIONS.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.id)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-2xs font-medium leading-4 transition-colors",
              selected
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
