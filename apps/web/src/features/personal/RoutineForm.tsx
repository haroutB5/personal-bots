import type { FormEvent, JSX } from "react";
import { useMemo, useState } from "react";

import {
  PersonalBotId,
  PersonalRoutineId,
  type PersonalRoutine,
  type PersonalRoutineMissedPolicy,
  type PersonalRoutineSchedule,
  type PersonalRoutineTrigger,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  draftFromRoutine,
  type RoutineDraft,
  type RoutineScheduleKind,
  sameSchedule,
  scheduleFromDraft,
  todayInZone,
  WEEKDAYS,
} from "./routineDraft";
import { PRIMARY_BUTTON } from "./TaskDetailScreen";
import { personalRoutineCreate, personalRoutineUpdate } from "./usePersonalAutomation";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";

const FIELD =
  "w-full rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] px-3.5 text-base text-[var(--personal-text)] outline-none placeholder:text-[var(--personal-text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";
const LABEL = "mb-1.5 block text-sm font-medium text-[var(--personal-text)]";

const KINDS: ReadonlyArray<{ readonly kind: RoutineScheduleKind; readonly label: string }> = [
  { kind: "daily", label: "Every day" },
  { kind: "weekly", label: "On chosen days" },
  { kind: "interval", label: "Every few hours" },
  { kind: "once", label: "Once" },
];

const TRIGGERS: ReadonlyArray<{
  readonly trigger: PersonalRoutineTrigger;
  readonly label: string;
}> = [
  { trigger: "schedule", label: "On a schedule" },
  { trigger: "event", label: "When an event fires" },
];

/** Shared choice-button styling for the trigger and schedule-kind pickers. */
const choiceButton = (selected: boolean) =>
  `h-11 rounded-[var(--personal-radius-button)] border text-[14px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] ${
    selected
      ? "border-[var(--personal-primary)] bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
      : "border-[var(--personal-border)] bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
  }`;

/** Create (routine = null) or edit a routine. The create id is fixed per form, so a retried save is idempotent. */
export function RoutineForm({ routine }: { routine: PersonalRoutine | null }): JSX.Element {
  const navigate = useNavigate();
  const environmentId = usePersonalEnvironmentId();
  const botsQuery = usePersonalBotsList(environmentId);
  const bots = useMemo(
    () => (botsQuery.data?.bots ?? []).toSorted((left, right) => left.sortOrder - right.sortOrder),
    [botsQuery.data],
  );
  const create = useAtomCommand(personalRoutineCreate);
  const update = useAtomCommand(personalRoutineUpdate);
  const [routineId] = useState(() => routine?.routineId ?? PersonalRoutineId.make(randomUUID()));
  const [draft, setDraft] = useState<RoutineDraft>(() =>
    draftFromRoutine(
      routine,
      bots.find((bot) => bot.name === "Planner")?.botId ?? bots[0]?.botId ?? "",
      todayInZone(Date.now(), routine?.timeZone ?? "Europe/London"),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const botId = draft.botId || bots[0]?.botId || "";
  const set = <K extends keyof RoutineDraft>(key: K, value: RoutineDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const isEvent = draft.trigger === "event";

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (environmentId === null || busy) return;
    // An event routine has no schedule to validate, and validating the hidden
    // schedule inputs would reject a perfectly valid event routine.
    let schedule: PersonalRoutineSchedule | null = null;
    if (!isEvent) {
      const built = scheduleFromDraft(draft);
      if ("error" in built) {
        setError(built.error);
        return;
      }
      schedule = built.schedule;
    }
    if (draft.title.trim().length === 0 || draft.prompt.trim().length === 0) {
      setError("Give the routine a name and a task.");
      return;
    }
    if (isEvent && draft.eventLabel.trim().length === 0) {
      setError("Name the event, for example 'PR merged'.");
      return;
    }
    if (botId.length === 0) {
      setError("Create a bot first.");
      return;
    }
    setError(null);
    setBusy(true);
    const common = {
      botId: PersonalBotId.make(botId),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      timeZone: draft.timeZone.trim() || "Europe/London",
      missedPolicy: draft.missedPolicy,
    };
    const result =
      routine === null
        ? await create({
            environmentId,
            input:
              schedule === null
                ? {
                    routineId,
                    trigger: "event" as const,
                    eventLabel: draft.eventLabel.trim(),
                    ...common,
                  }
                : { routineId, schedule, ...common },
          })
        : await update({
            environmentId,
            input:
              schedule === null
                ? { routineId, ...common, eventLabel: draft.eventLabel.trim() }
                : {
                    routineId,
                    ...common,
                    // Unchanged interval schedules keep their anchor (and cadence).
                    ...(routine.schedule !== null && sameSchedule(schedule, routine.schedule)
                      ? {}
                      : { schedule }),
                  },
          });
    setBusy(false);
    if (result._tag === "Success") {
      await navigate({ to: "/tasks/routines/$routineId", params: { routineId } });
      return;
    }
    setError(commandFailureMessage(result, "The routine could not be saved."));
  };

  return (
    <div className="flex flex-col px-5 pb-8">
      <header className="flex h-14 items-center gap-1">
        {routine === null ? (
          <Link
            to="/tasks"
            search={{ view: "scheduled" }}
            aria-label="Back to Scheduled"
            className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </Link>
        ) : (
          <Link
            to="/tasks/routines/$routineId"
            params={{ routineId: routine.routineId }}
            aria-label="Back to routine"
            className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
          </Link>
        )}
        <h1 className="text-[19px] font-bold text-[var(--personal-text)]">
          {routine === null ? "New routine" : "Edit routine"}
        </h1>
      </header>

      <form
        onSubmit={(event) => void onSubmit(event)}
        noValidate
        className="mt-2 flex flex-col gap-5"
      >
        <div>
          <label htmlFor="routine-title" className={LABEL}>
            Name
          </label>
          <input
            id="routine-title"
            className={`${FIELD} h-11`}
            value={draft.title}
            maxLength={80}
            placeholder="Morning briefing"
            onChange={(event) => set("title", event.target.value)}
          />
        </div>

        <div>
          <label htmlFor="routine-bot" className={LABEL}>
            Bot
          </label>
          <select
            id="routine-bot"
            className={`${FIELD} h-11`}
            value={botId}
            onChange={(event) => set("botId", event.target.value)}
          >
            {bots.map((bot) => (
              <option key={bot.botId} value={bot.botId}>
                {bot.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="routine-prompt" className={LABEL}>
            Task each time it runs
          </label>
          <textarea
            id="routine-prompt"
            className={`${FIELD} min-h-28 py-2.5 leading-snug`}
            value={draft.prompt}
            maxLength={4_000}
            placeholder="Summarise my calendar and anything waiting on me."
            onChange={(event) => set("prompt", event.target.value)}
          />
        </div>

        {routine === null ? (
          <fieldset>
            <legend className={LABEL}>What starts it</legend>
            <div className="grid grid-cols-2 gap-2">
              {TRIGGERS.map((option) => (
                <button
                  key={option.trigger}
                  type="button"
                  aria-pressed={draft.trigger === option.trigger}
                  onClick={() => set("trigger", option.trigger)}
                  className={choiceButton(draft.trigger === option.trigger)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        {isEvent ? (
          <div>
            <label htmlFor="routine-event-label" className={LABEL}>
              Event name
            </label>
            <input
              id="routine-event-label"
              className={`${FIELD} h-11`}
              value={draft.eventLabel}
              maxLength={60}
              placeholder="PR merged"
              aria-describedby="routine-event-hint"
              onChange={(event) => set("eventLabel", event.target.value)}
            />
            <p
              id="routine-event-hint"
              className="mt-1.5 text-[13px] text-[var(--personal-text-secondary)]"
            >
              After you save, this routine gets its own webhook URL. Anything that can send a POST
              request can start it.
            </p>
          </div>
        ) : (
          <fieldset>
            <legend className={LABEL}>When</legend>
            <div className="grid grid-cols-2 gap-2">
              {KINDS.map((option) => (
                <button
                  key={option.kind}
                  type="button"
                  aria-pressed={draft.kind === option.kind}
                  onClick={() => set("kind", option.kind)}
                  className={choiceButton(draft.kind === option.kind)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {!isEvent && draft.kind === "weekly" ? (
          <fieldset>
            <legend className={LABEL}>Days</legend>
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAYS.map(({ day, short }) => {
                const on = draft.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        "days",
                        on ? draft.days.filter((entry) => entry !== day) : [...draft.days, day],
                      )
                    }
                    className={`h-11 rounded-[var(--personal-radius-button)] text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] ${
                      on
                        ? "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
                        : "bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
                    }`}
                  >
                    {short}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {isEvent ? null : draft.kind === "interval" ? (
          <div>
            <label htmlFor="routine-hours" className={LABEL}>
              Every how many hours
            </label>
            <input
              id="routine-hours"
              type="number"
              inputMode="numeric"
              min={1}
              max={168}
              className={`${FIELD} h-11`}
              value={draft.everyHours}
              onChange={(event) => set("everyHours", event.target.value)}
            />
            <p className="mt-1.5 text-[13px] text-[var(--personal-text-secondary)]">
              Counts real hours from when you save, so it keeps its rhythm across clock changes.
            </p>
          </div>
        ) : (
          <div className="flex gap-3">
            {draft.kind === "once" ? (
              <div className="flex-1">
                <label htmlFor="routine-date" className={LABEL}>
                  Date
                </label>
                <input
                  id="routine-date"
                  type="date"
                  className={`${FIELD} h-11`}
                  value={draft.date}
                  onChange={(event) => set("date", event.target.value)}
                />
              </div>
            ) : null}
            <div className="flex-1">
              <label htmlFor="routine-time" className={LABEL}>
                Time
              </label>
              <input
                id="routine-time"
                type="time"
                className={`${FIELD} h-11`}
                value={draft.time}
                onChange={(event) => set("time", event.target.value)}
              />
            </div>
          </div>
        )}

        {isEvent ? null : (
          <div>
            <label htmlFor="routine-zone" className={LABEL}>
              Time zone
            </label>
            <input
              id="routine-zone"
              className={`${FIELD} h-11`}
              value={draft.timeZone}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => set("timeZone", event.target.value)}
            />
            <p className="mt-1.5 text-[13px] text-[var(--personal-text-secondary)]">
              Wall-clock time: a 09:00 routine stays at 09:00 when the clocks change.
            </p>
          </div>
        )}

        {isEvent ? null : (
          <fieldset>
            <legend className={LABEL}>If the laptop was asleep at run time</legend>
            {(
              [
                ["coalesce", "Run once when it wakes (latest missed run only)"],
                ["skip", "Skip missed runs"],
              ] as ReadonlyArray<readonly [PersonalRoutineMissedPolicy, string]>
            ).map(([policy, label]) => (
              <label
                key={policy}
                className="flex min-h-11 items-center gap-3 text-[15px] text-[var(--personal-text)]"
              >
                <input
                  type="radio"
                  name="routine-missed"
                  className="size-5 accent-[var(--personal-primary)]"
                  checked={draft.missedPolicy === policy}
                  onChange={() => set("missedPolicy", policy)}
                />
                {label}
              </label>
            ))}
          </fieldset>
        )}

        {error !== null ? (
          <p role="alert" className="text-[14px] text-[var(--personal-error)]">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className={PRIMARY_BUTTON}
          disabled={busy || environmentId === null}
          aria-busy={busy}
        >
          {routine === null ? "Create routine" : "Save changes"}
        </button>
      </form>
    </div>
  );
}
