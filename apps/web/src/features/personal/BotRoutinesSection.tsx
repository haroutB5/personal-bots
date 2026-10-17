import type { JSX } from "react";

import { describePersonalRoutineTrigger, type EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";

import { botSettingsRoutines } from "./conversationRoutinesModel";
import { routineTriggerStatusLabel } from "./routineHook";
import { usePersonalRoutines } from "./usePersonalAutomation";

/**
 * Every routine this bot runs, on its own settings page. Tap a row for the
 * routine's page, which holds edit, pause and delete. Read-only here: a routine
 * can belong to a chat or be made elsewhere, so the form posts no routine state
 * and leaving this page unsaved changes nothing about them.
 */
export function BotRoutinesSection({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly botId: string;
}): JSX.Element {
  const query = usePersonalRoutines(environmentId);
  const routines = botSettingsRoutines(query.data?.routines ?? [], botId);

  return (
    <section
      aria-labelledby="bot-routines-heading"
      data-testid="bot-routines"
      className="flex flex-col gap-3 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4"
    >
      <div>
        <h2 id="bot-routines-heading" className="text-sm font-medium text-[var(--personal-text)]">
          Routines
        </h2>
        <p className="mt-1 text-sm text-[var(--personal-text-secondary)]">
          Everything this bot runs on a schedule or when an event fires.
        </p>
      </div>
      {query.error !== null ? (
        <p role="alert" className="text-sm text-[var(--personal-error)]">
          Couldn't load this bot's routines.
        </p>
      ) : query.data === null ? (
        <p aria-busy="true" className="text-sm text-[var(--personal-text-secondary)]">
          Loading routines…
        </p>
      ) : routines.length === 0 ? (
        <p className="text-sm text-[var(--personal-text-secondary)]">No routines yet</p>
      ) : (
        <ul className="divide-y divide-[var(--personal-border)]">
          {routines.map((routine) => (
            <li key={routine.routineId}>
              <Link
                to="/tasks/routines/$routineId"
                params={{ routineId: routine.routineId }}
                activeOptions={{ exact: true }}
                className="flex min-h-11 items-center gap-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[14px] font-medium text-[var(--personal-text)]">
                    {routine.title}
                  </span>
                  <span className="truncate text-[12px] leading-4 text-[var(--personal-text-secondary)]">
                    {describePersonalRoutineTrigger(routine)}
                  </span>
                  <span className="truncate text-[12px] leading-4 text-[var(--personal-text-tertiary)]">
                    {routineTriggerStatusLabel(routine)}
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
      )}
    </section>
  );
}
