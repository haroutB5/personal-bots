import type { JSX } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { TriangleAlert } from "lucide-react";

import { cn } from "~/lib/utils";

import { rulesUsageCardModel, type RulesUsageCardModel } from "./memoryPresentation";
import { usePersonalMemoryRulesUsage } from "./usePersonalAutomation";

/** The warning itself: how full the rules are, and any that would not fit, whole. */
export function RulesUsageCardView({ model }: { model: RulesUsageCardModel }): JSX.Element {
  return (
    <section
      aria-label="Rules limit"
      className="mt-4 rounded-[var(--personal-radius-card)] border border-[var(--personal-review-border)] bg-[var(--personal-review-bg)] p-3.5"
    >
      <p className="flex items-start gap-2 text-[15px] font-semibold text-[var(--personal-text)]">
        <TriangleAlert
          aria-hidden="true"
          className="mt-[3px] size-4 shrink-0 text-[var(--personal-text-secondary)]"
          strokeWidth={2}
        />
        <span className="min-w-0 break-words">{model.headline}</span>
      </p>
      <p className="mt-1.5 text-[13px] leading-[1.4] text-[var(--personal-text-secondary)]">
        {model.detail}
      </p>
      <ul className="mt-2.5 flex flex-col gap-2">
        {model.rows.map((row) => (
          <li key={row.key} className="min-w-0">
            <p className="text-[13px] font-medium break-words text-[var(--personal-text)]">
              {row.label}
            </p>
            <p className="text-[12px] text-[var(--personal-text-secondary)]">{row.line}</p>
            <div
              aria-hidden="true"
              className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-[var(--personal-fill-muted)]"
            >
              <div
                className={cn(
                  "h-full rounded-full bg-[var(--personal-text)]",
                  row.share >= 1 ? "opacity-100" : "opacity-60",
                )}
                style={{ width: `${Math.round(row.share * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      {model.leftOut.length > 0 ? (
        <div className="mt-3 min-w-0">
          <p className="text-[12px] font-semibold tracking-wide text-[var(--personal-text-secondary)] uppercase">
            Would be left out
          </p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {model.leftOut.map((rule) => (
              <li
                key={rule.memoryId}
                className="border-l-2 border-[var(--personal-border)] pl-2 text-[13px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text)]"
              >
                {rule.content}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** Shown on the Memory screen only while a bot's rules are at 80% of the per-turn limit or over it. */
export function RulesUsageCard({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}): JSX.Element | null {
  const usage = usePersonalMemoryRulesUsage(environmentId);
  if (usage.data === null) return null;
  const model = rulesUsageCardModel(usage.data);
  return model === null ? null : <RulesUsageCardView model={model} />;
}
