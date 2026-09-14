import type { JSX } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { routinesForBot } from "./conversationRoutinesModel";
import { routineNextRunLabel } from "./taskPresentation";
import { usePersonalRoutines } from "./usePersonalAutomation";

export function ConversationRoutinesPanel({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
}): JSX.Element | null {
  const query = usePersonalRoutines(environmentId);
  const routines = routinesForBot(query.data?.routines ?? [], botId);
  if (query.error !== null || routines.length === 0) return null;

  return (
    <section
      aria-labelledby="conversation-routines-heading"
      className="shrink-0 border-t border-[var(--personal-border)] bg-[var(--personal-surface)] px-4 pb-1"
    >
      <div className="flex min-h-11 items-center justify-between gap-3">
        <h2
          id="conversation-routines-heading"
          className="text-[14px] font-semibold text-[var(--personal-text)]"
        >
          Routines
        </h2>
        <Link
          to="/tasks"
          search={{ view: "scheduled" }}
          className="flex min-h-11 items-center gap-0.5 rounded-md text-[13px] font-medium text-[var(--personal-text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
        >
          See all
          <ChevronRight aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </Link>
      </div>
      <ul className="divide-y divide-[var(--personal-border)]">
        {routines.map((routine) => (
          <li key={routine.routineId}>
            <Link
              to="/tasks/routines/$routineId"
              params={{ routineId: routine.routineId }}
              className="flex min-h-11 items-center gap-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-[var(--personal-text)]">
                  {routine.title}
                </span>
                <span className="block truncate text-[12px] leading-4 text-[var(--personal-text-tertiary)]">
                  {routineNextRunLabel(routine)}
                </span>
              </span>
              <ChevronRight
                aria-hidden="true"
                className="size-4 shrink-0 text-[var(--personal-text-tertiary)]"
                strokeWidth={1.75}
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
