import type { JSX } from "react";

import { Link } from "@tanstack/react-router";
import { CircleCheck, File, Laptop, MessageCircle, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { useNeedsYouCount } from "./needsYouStore";
import { PERSONAL_TABS, type PersonalTab } from "./personalMode";

const TAB_ICONS: Record<PersonalTab, LucideIcon> = {
  chats: MessageCircle,
  tasks: CircleCheck,
  computer: Laptop,
  files: File,
};

/**
 * Bottom tab bar: top hairline, 49 px plus the safe-area inset, four equal
 * columns with a 26 px icon over an 11 px label. The active tab is the text
 * colour, label 600, with a filled icon (inner strokes such as the check mark
 * are knocked out in the surface colour).
 *
 * The Bots tab carries the needs-you count, the same number the home's filter
 * chip shows (`needsYouStore`). It sits at the icon's top-right with a 2 px
 * ring in the bar's own colour, so it reads as a badge cut out of the bar
 * rather than a dot floating over it.
 */
export function PersonalTabBar({ active }: { readonly active: PersonalTab }): JSX.Element {
  const needsYou = useNeedsYouCount();
  return (
    <nav
      aria-label="Primary"
      className="shrink-0 border-t-[var(--personal-hairline)] border-[var(--personal-border)] bg-[var(--personal-bar)] pb-[env(safe-area-inset-bottom)] backdrop-blur-[20px] backdrop-saturate-[1.4]"
    >
      <ul className="grid h-[49px] grid-cols-4">
        {PERSONAL_TABS.map(({ tab, label, to }) => {
          const Icon = TAB_ICONS[tab];
          const isActive = tab === active;
          const badge = tab === "chats" && needsYou > 0 ? needsYou : null;
          return (
            <li key={tab} className="flex">
              <Link
                to={to}
                // Explicitly empty: a tab-bar tap is an origin-less visit, so
                // /computer must never inherit a previous visit's `fromBot`.
                search={{}}
                aria-current={isActive ? "page" : undefined}
                aria-label={
                  tab === "chats" && needsYou > 0 ? `Bots, ${needsYou} need you` : undefined
                }
                className={cn(
                  "relative flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] leading-[13px] outline-none",
                  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]",
                  isActive
                    ? "font-semibold text-[var(--personal-text)]"
                    : "font-medium text-[var(--personal-text-secondary)]",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-[26px]",
                    isActive &&
                      tab === "tasks" &&
                      "[&>path]:stroke-[var(--personal-surface)] [&>path]:[stroke-width:2.25]",
                  )}
                  strokeWidth={1.75}
                  fill={isActive ? "currentColor" : "none"}
                />
                <span>{label}</span>
                {/* After the label in the markup (the tab reads "Bots 5"), drawn
                    at the icon's top-right corner. */}
                {badge !== null ? (
                  <span
                    aria-hidden="true"
                    data-testid="tab-needs-badge"
                    className="absolute top-px left-[calc(50%+5px)] flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-[var(--personal-state-needs)] px-[5px] text-[11px] leading-[18px] font-bold text-[var(--personal-primary-text)] tabular-nums shadow-[0_0_0_2px_var(--personal-bar-solid)]"
                  >
                    {badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
