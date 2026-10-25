import type { JSX } from "react";

import type { PersonalBotTokenUsageWindowId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";

import { TOKEN_USAGE_WINDOWS } from "./tokenUsagePresentation";

/**
 * Today / 7 days / 30 days. One control for the Team card and the bot sheet:
 * both draw it from the same state, so changing it in either changes both.
 */
export function UsageRangeControl({
  windowId,
  onChange,
}: {
  readonly windowId: PersonalBotTokenUsageWindowId;
  readonly onChange: (id: PersonalBotTokenUsageWindowId) => void;
}): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Time range"
      className="grid grid-cols-3 gap-1 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] p-1"
    >
      {TOKEN_USAGE_WINDOWS.map((option) => {
        const on = option.id === windowId;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(option.id)}
            className={cn(
              "min-h-11 rounded-[8px] px-2 text-[15px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]",
              on
                ? "bg-[var(--personal-primary)] font-semibold text-[var(--personal-primary-text)]"
                : "font-medium text-[var(--personal-text-secondary)]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
