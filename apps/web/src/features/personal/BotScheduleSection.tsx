import type { JSX } from "react";

import type { ServerProvider } from "@t3tools/contracts";

import { FIELD_CLASS, LABEL_CLASS } from "./BotModelFields";
import { BotModelPickFields, MODEL_PICK_HELP_CLASS } from "./BotModelPickFields";
import { SCHEDULE_TIME_OPTIONS, scheduleHelpLine, type ScheduleDraft } from "./botFormModel";

/** The choices a time picker shows: every 15 minutes, plus a saved time that is off that grid. */
function timeChoices(current: string): ReadonlyArray<string> {
  return SCHEDULE_TIME_OPTIONS.includes(current) || current === ""
    ? SCHEDULE_TIME_OPTIONS
    : [...SCHEDULE_TIME_OPTIONS, current].toSorted();
}

/**
 * "Use a different model at set times": a daily From and To (the laptop's local
 * time, 15-minute steps, overnight is fine) and the model the bot runs on in
 * between. The usage-limit fallback section above it is separate and always
 * wins. One line under the pickers says what the schedule does.
 */
export function BotScheduleSection({
  draft,
  onChange,
  providers,
  providerOptions,
  problem,
  modelLabel,
}: {
  readonly draft: ScheduleDraft;
  readonly onChange: (patch: Partial<ScheduleDraft>) => void;
  /** Every provider the client knows, to tell whether the scheduled one can run. */
  readonly providers: ReadonlyArray<ServerProvider>;
  /** The providers the scheduled model may be on (the saved one stays listed). */
  readonly providerOptions: ReadonlyArray<ServerProvider>;
  /** Why the schedule cannot be saved yet, in plain words; null when it can. */
  readonly problem: string | null;
  /** The scheduled model as a label ("Sonnet 5.5 high"), for the result line. */
  readonly modelLabel: string | null;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Model schedule"
      data-testid="bot-schedule"
      className="flex flex-col gap-5 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)] p-4"
    >
      <label className="flex min-h-11 items-center gap-3 text-[15px] text-[var(--personal-text)]">
        <input
          type="checkbox"
          role="switch"
          checked={draft.enabled}
          onChange={(event) => onChange({ enabled: event.target.checked })}
          className="size-5 shrink-0"
        />
        <span className="min-w-0">
          Use a different model at set times
          <span className="block text-sm text-[var(--personal-text-secondary)]">
            Every day, between these times (your laptop's clock), the bot uses this model instead.
          </span>
        </span>
      </label>

      {draft.enabled ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="bot-schedule-from" className={LABEL_CLASS}>
                From
              </label>
              <select
                id="bot-schedule-from"
                value={draft.from}
                onChange={(event) => onChange({ from: event.target.value })}
                className={`${FIELD_CLASS} h-11`}
              >
                {timeChoices(draft.from).map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="bot-schedule-to" className={LABEL_CLASS}>
                To
              </label>
              <select
                id="bot-schedule-to"
                value={draft.to}
                onChange={(event) => onChange({ to: event.target.value })}
                className={`${FIELD_CLASS} h-11`}
              >
                {timeChoices(draft.to).map((time) => (
                  <option key={time} value={time}>
                    {time}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <BotModelPickFields
            idPrefix="bot-schedule"
            labelPrefix="Scheduled"
            draft={draft}
            onChange={onChange}
            providers={providers}
            providerOptions={providerOptions}
            unavailableNote={(label) =>
              `${label} can't run right now, so the bot stays on its own model.`
            }
          />

          {problem === null ? (
            <p data-testid="bot-schedule-summary" className={MODEL_PICK_HELP_CLASS}>
              {scheduleHelpLine(draft, modelLabel)}
            </p>
          ) : (
            <p
              data-testid="bot-schedule-problem"
              role="alert"
              className="text-sm text-[var(--personal-error)]"
            >
              {problem}
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
