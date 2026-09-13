import type { JSX } from "react";

import type { LucideIcon } from "lucide-react";

/**
 * Honest placeholder for a tab whose feature has not shipped yet. It states
 * what the tab will hold and offers no controls, so nothing on it is dead.
 */
export function PersonalEmptyTab({
  title,
  heading,
  description,
  icon: Icon,
}: {
  title: string;
  heading: string;
  description: string;
  icon: LucideIcon;
}): JSX.Element {
  return (
    <div className="flex min-h-full flex-col px-5">
      <header className="flex h-14 items-center">
        <h1 className="text-[28px] leading-none font-bold text-[var(--personal-text)]">{title}</h1>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-16 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-[var(--personal-fill-muted)]">
          <Icon
            aria-hidden="true"
            className="size-6 text-[var(--personal-text-secondary)]"
            strokeWidth={1.75}
          />
        </span>
        <h2 className="text-lg font-semibold text-[var(--personal-text)]">{heading}</h2>
        <p className="max-w-[280px] text-[15px] leading-snug text-[var(--personal-text-secondary)]">
          {description}
        </p>
      </div>
    </div>
  );
}
