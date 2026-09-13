import type { JSX } from "react";
import { useMemo, useState } from "react";

import { describePersonalRoutineSchedule, type PersonalRoutineId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { ChevronLeft } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { formatLocalDateTime } from "./taskPresentation";
import { DETAIL_CARD, DetailRow, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./TaskDetailScreen";
import { routineNextRunLabel, SmallBotAvatar } from "./TasksScreen";
import {
  personalRoutineDelete,
  personalRoutinePause,
  personalRoutineResume,
  personalRoutineRunNow,
  usePersonalRoutines,
} from "./usePersonalAutomation";
import { usePersonalBotsList, usePersonalEnvironmentId } from "./usePersonalBots";

const OCCURRENCE_STATUS = {
  created: "Ran",
  skipped: "Skipped (missed)",
  failed: "Failed",
} as const;

function occurrenceLabel(localOccurrence: string): string {
  if (localOccurrence.startsWith("manual:")) return "Run now";
  return localOccurrence.replace("T", " ").slice(0, 16);
}

/** /tasks/routines/$routineId: schedule, next run, history; pause, run now, edit, delete. */
export function RoutineDetailScreen({ routineId }: { routineId: PersonalRoutineId }): JSX.Element {
  const navigate = useNavigate();
  const environmentId = usePersonalEnvironmentId();
  const routinesQuery = usePersonalRoutines(environmentId);
  const botsQuery = usePersonalBotsList(environmentId);
  const pause = useAtomCommand(personalRoutinePause);
  const resume = useAtomCommand(personalRoutineResume);
  const runNow = useAtomCommand(personalRoutineRunNow);
  const remove = useAtomCommand(personalRoutineDelete);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const routine = routinesQuery.data?.routines.find((entry) => entry.routineId === routineId);
  const occurrences = useMemo(
    () => (routinesQuery.data?.occurrences ?? []).filter((entry) => entry.routineId === routineId),
    [routinesQuery.data, routineId],
  );
  const bot = botsQuery.data?.bots.find((entry) => entry.botId === routine?.botId);

  const header = (
    <header className="flex h-14 items-center gap-1">
      <Link
        to="/tasks"
        search={{ view: "scheduled" }}
        aria-label="Back to Scheduled"
        className="-ml-3 flex size-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
      >
        <ChevronLeft aria-hidden="true" className="size-6" strokeWidth={1.75} />
      </Link>
      <h1 className="text-[19px] font-bold text-[var(--personal-text)]">Routine</h1>
    </header>
  );

  if (routine === undefined || environmentId === null) {
    return (
      <div className="px-5">
        {header}
        <p className="mt-6 text-[15px] text-[var(--personal-text-secondary)]">
          {routinesQuery.data === null ? "Loading..." : "This routine was not found."}
        </p>
      </div>
    );
  }

  const act = async (action: "toggle" | "run" | "delete") => {
    setActionError(null);
    if (action === "delete") {
      const message = `Delete the routine "${routine.title}"?\nTasks it already started stay in Tasks.`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setBusy(true);
    const input = { routineId: routine.routineId };
    if (action === "run") {
      const result = await runNow({ environmentId, input: { ...input, requestId: randomUUID() } });
      setBusy(false);
      if (result._tag === "Success") {
        await navigate({ to: "/tasks/$taskId", params: { taskId: result.value.task.taskId } });
        return;
      }
      setActionError(commandFailureMessage(result, "The routine could not start."));
      return;
    }
    const result =
      action === "delete"
        ? await remove({ environmentId, input })
        : routine.enabled
          ? await pause({ environmentId, input })
          : await resume({ environmentId, input });
    setBusy(false);
    if (result._tag === "Success" && action === "delete") {
      await navigate({ to: "/tasks", search: { view: "scheduled" } });
      return;
    }
    setActionError(commandFailureMessage(result, "That did not work. Try again."));
  };

  return (
    <div className="flex flex-col gap-4 px-5 pb-8">
      {header}
      <section className={DETAIL_CARD}>
        <div className="flex items-center gap-3">
          <SmallBotAvatar bot={bot} />
          <span className="text-[15px] font-semibold text-[var(--personal-text)]">
            {bot?.name ?? "Deleted bot"}
          </span>
        </div>
        <h2 className="mt-3 text-[17px] font-semibold text-[var(--personal-text)]">
          {routine.title}
        </h2>
        <p className="mt-1 text-[14px] text-[var(--personal-text-secondary)]">
          {describePersonalRoutineSchedule(routine.schedule, routine.timeZone)}
        </p>
        <dl className="mt-3 border-t border-[var(--personal-border)] pt-2">
          <DetailRow label="Next run">
            {routineNextRunLabel(routine).replace(/^Next: /, "")}
          </DetailRow>
          <DetailRow label="Time zone">{routine.timeZone}</DetailRow>
          <DetailRow label="If the laptop was asleep">
            {routine.missedPolicy === "coalesce" ? "Run once to catch up" : "Skip missed runs"}
          </DetailRow>
          <DetailRow label="Created">
            {formatLocalDateTime(DateTime.toEpochMillis(routine.createdAt))}
          </DetailRow>
        </dl>
      </section>

      <section className={DETAIL_CARD}>
        <h3 className="text-[14px] font-semibold text-[var(--personal-text)]">Task</h3>
        <p className="mt-1 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-[var(--personal-text)]">
          {routine.prompt}
        </p>
      </section>

      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={busy}
          onClick={() => void act("run")}
        >
          Run now
        </button>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={busy}
          onClick={() => void act("toggle")}
        >
          {routine.enabled ? "Pause" : "Resume"}
        </button>
        <Link
          to="/tasks/routines/$routineId/edit"
          params={{ routineId: routine.routineId }}
          className={SECONDARY_BUTTON}
        >
          Edit
        </Link>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={busy}
          onClick={() => void act("delete")}
        >
          Delete
        </button>
      </div>
      {actionError !== null ? (
        <p role="alert" className="text-[14px] text-[#B3261E]">
          {actionError}
        </p>
      ) : null}

      <section>
        <h3 className="mb-1 text-[13px] font-semibold text-[var(--personal-text-secondary)] uppercase">
          Recent runs
        </h3>
        {occurrences.length === 0 ? (
          <p className="text-[14px] text-[var(--personal-text-secondary)]">No runs yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--personal-border)]">
            {occurrences.map((occurrence) => {
              const label = (
                <>
                  <span className="text-[14px] text-[var(--personal-text)] tabular-nums">
                    {occurrenceLabel(occurrence.localOccurrence)}
                  </span>
                  <span className="text-[13px] text-[var(--personal-text-secondary)]">
                    {OCCURRENCE_STATUS[occurrence.status]}
                  </span>
                </>
              );
              return (
                <li key={occurrence.localOccurrence}>
                  {occurrence.taskId !== null ? (
                    <Link
                      to="/tasks/$taskId"
                      params={{ taskId: occurrence.taskId }}
                      className="flex min-h-11 items-center justify-between gap-3 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)]"
                    >
                      {label}
                    </Link>
                  ) : (
                    <div className="flex min-h-11 items-center justify-between gap-3">{label}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
