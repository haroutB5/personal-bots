import type { JSX } from "react";

import { Link } from "@tanstack/react-router";
import { CircleCheck, File, MessageCircle, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { PERSONAL_TABS, type PersonalTab } from "./personalMode";

const TAB_ICONS: Record<PersonalTab, LucideIcon> = {
  chats: MessageCircle,
  tasks: CircleCheck,
  files: File,
};

/**
 * Bottom tab bar (ui-spec "Tab bar"): top hairline, 56px + safe-area bottom,
 * three equal columns with a 24px outline icon over a 12px label. The active
 * tab is `#171717`, label 600, with a filled icon (inner strokes such as the
 * check mark are knocked out in the surface colour).
 */
export function PersonalTabBar({ active }: { active: PersonalTab }): JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="shrink-0 border-t border-[var(--personal-border)] bg-[var(--personal-surface)] pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="grid h-14 grid-cols-3">
        {PERSONAL_TABS.map(({ tab, label, to }) => {
          const Icon = TAB_ICONS[tab];
          const isActive = tab === active;
          return (
            <li key={tab} className="flex">
              <Link
                to={to}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-xs outline-none",
                  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]",
                  isActive
                    ? "font-semibold text-[var(--personal-text)]"
                    : "font-normal text-[var(--personal-text-secondary)]",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-6",
                    isActive &&
                      tab === "tasks" &&
                      "[&>path]:stroke-[var(--personal-surface)] [&>path]:[stroke-width:2.25]",
                  )}
                  strokeWidth={1.75}
                  fill={isActive ? "currentColor" : "none"}
                />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
