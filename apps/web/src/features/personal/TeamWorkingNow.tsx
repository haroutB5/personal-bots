import type { JSX } from "react";

import type { PersonalBot } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { BotAvatar } from "./BotAvatar";
import { formatWorkingFor, workingNowTarget, type WorkingNowItem } from "./teamConstellationModel";

/**
 * The handoffs running right now. A tap opens the receiving bot's task chat,
 * where the work can be steered; a handoff that has no chat yet opens its task
 * page instead. Nothing renders while nothing is running.
 */
export function TeamWorkingNow({
  items,
  botsById,
  nowMs,
}: {
  readonly items: ReadonlyArray<WorkingNowItem>;
  readonly botsById: ReadonlyMap<string, PersonalBot>;
  readonly nowMs: number;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section aria-label="Handoffs running now" className="mb-3.5">
      <h2 className="mt-1 mb-2 flex items-center gap-2 px-1 text-[13px] leading-[18px] font-semibold text-[var(--personal-section-label)]">
        <span
          aria-hidden="true"
          className="size-2 rounded-full bg-[var(--personal-team-live)] shadow-[0_0_0_4px_color-mix(in_srgb,var(--personal-team-live)_22%,transparent)]"
        />
        Working now · {items.length}
      </h2>
      <ul className="divide-y divide-[var(--personal-border)] overflow-hidden rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] shadow-[var(--personal-shadow-card)]">
        {items.map((item) => {
          const from = botsById.get(item.from);
          const to = botsById.get(item.to);
          if (from === undefined || to === undefined) return null;
          const target = workingNowTarget(item);
          const opens = item.threadId === null ? "task" : `${to.name}'s chat for this task`;
          return (
            <li key={item.taskId}>
              <Link
                {...target}
                aria-label={`${from.name} to ${to.name}: ${item.title}. Open ${opens}.`}
                className="flex min-h-16 items-center gap-2.5 px-3.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
              >
                <span aria-hidden="true" className="flex shrink-0 items-center gap-1.5">
                  <BotAvatar shape={from.avatarShape} color={from.avatarColor} size={28} label="" />
                  <ArrowRight
                    className="size-3.5 text-[var(--personal-team-live)]"
                    strokeWidth={2.25}
                  />
                  <BotAvatar shape={to.avatarShape} color={to.avatarColor} size={28} label="" />
                </span>
                <span aria-hidden="true" className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] leading-5 font-semibold text-[var(--personal-text)]">
                    {from.name} → {to.name}
                  </span>
                  <span className="block truncate text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
                    {item.title}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-[13px] text-[var(--personal-text-secondary)]"
                >
                  {formatWorkingFor(item.sinceMs, nowMs)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
