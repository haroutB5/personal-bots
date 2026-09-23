import type { JSX } from "react";
import { useMemo, useState } from "react";

import { describePersonalRoutineTrigger, type PersonalRoutineId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { Check, ChevronLeft, Copy } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { currentOrigin, isEventRoutine, isLocalOnlyOrigin, routineHookUrl } from "./routineHook";
import { formatLocalDateTime } from "./taskPresentation";
import { DETAIL_CARD, DetailRow, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./TaskDetailScreen";
import { routineNextRunLabel } from "./taskPresentation";
import { SmallBotAvatar } from "./TasksScreen";
import {
  personalRoutineDelete,
  personalRoutinePause,
  personalRoutineRegenerateHook,
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
  if (localOccurrence.startsWith("event:")) {
    return `Event ${localOccurrence.slice("event:".length).replace("T", " ").slice(0, 16)}`;
  }
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
  const regenerateHook = useAtomCommand(personalRoutineRegenerateHook);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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
        (await requestConfirmDialog(message, {
          variant: "destructive",
          confirmLabel: "Delete routine",
        })) ?? window.confirm(message);
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

  const isEvent = isEventRoutine(routine);
  const origin = currentOrigin();
  const hookUrl =
    routine.hookToken === null || origin === null
      ? null
      : routineHookUrl(origin, routine.hookToken);
  const localOnlyUrl = origin !== null && isLocalOnlyOrigin(origin);

  const copyHookUrl = async () => {
    if (hookUrl === null) return;
    setActionError(null);
    try {
      await writeTextToClipboard(hookUrl, "webhook URL");
      setCopied(true);
    } catch {
      // A phone browser can refuse the clipboard outright; the URL is on screen
      // and selectable, so say what happened instead of failing silently.
      setActionError("Could not copy. Select the URL and copy it by hand.");
    }
  };

  const rotateHook = async () => {
    setActionError(null);
    const message = [
      "Get a new webhook URL?",
      "The current URL stops working straight away, so anything already using it must be updated.",
    ].join("\n");
    const confirmed =
      (await requestConfirmDialog(message, {
        variant: "destructive",
        confirmLabel: "Get new URL",
      })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy(true);
    const result = await regenerateHook({ environmentId, input: { routineId: routine.routineId } });
    setBusy(false);
    setCopied(false);
    if (result._tag !== "Success") {
      setActionError(commandFailureMessage(result, "The URL could not be regenerated."));
    }
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
          {describePersonalRoutineTrigger(routine)}
        </p>
        <dl className="mt-3 border-t border-[var(--personal-border)] pt-2">
          {isEvent ? (
            <>
              <DetailRow label="Last fired">
                {routine.lastFiredAt === null
                  ? "Never"
                  : formatLocalDateTime(DateTime.toEpochMillis(routine.lastFiredAt))}
              </DetailRow>
              <DetailRow label="Status">
                {routine.enabled ? "Listening for events" : "Paused"}
              </DetailRow>
            </>
          ) : (
            <>
              <DetailRow label="Next run">
                {routineNextRunLabel(routine).replace(/^Next: /, "")}
              </DetailRow>
              <DetailRow label="Time zone">{routine.timeZone}</DetailRow>
              <DetailRow label="If the laptop was asleep">
                {routine.missedPolicy === "coalesce" ? "Run once to catch up" : "Skip missed runs"}
              </DetailRow>
            </>
          )}
          <DetailRow label="Created">
            {formatLocalDateTime(DateTime.toEpochMillis(routine.createdAt))}
          </DetailRow>
        </dl>
      </section>

      {isEvent ? (
        <section className={DETAIL_CARD}>
          <h3 className="text-[14px] font-semibold text-[var(--personal-text)]">Webhook URL</h3>
          <p className="mt-1 text-[13px] text-[var(--personal-text-secondary)]">
            Anything that can send a POST request to this URL starts the routine. Treat it like a
            password: the URL is the only thing standing between the internet and this bot.
          </p>
          {hookUrl === null ? (
            <p className="mt-2 text-[14px] text-[var(--personal-text-secondary)]">
              The URL is not available on this screen.
            </p>
          ) : (
            <>
              <p
                data-testid="routine-hook-url"
                className="mt-2 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] px-3 py-2 font-mono text-[13px] break-all text-[var(--personal-text)] select-all"
              >
                {hookUrl}
              </p>
              {localOnlyUrl ? (
                <p role="alert" className="mt-2 text-[13px] text-[var(--personal-danger)]">
                  This address only works on this computer. Open the app through your T3 Connect
                  tunnel and copy the URL from there, or nothing outside can reach it.
                </p>
              ) : null}
              <div className="mt-2.5 grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  onClick={() => void copyHookUrl()}
                >
                  {copied ? (
                    <Check aria-hidden="true" className="mr-1.5 inline size-4" />
                  ) : (
                    <Copy aria-hidden="true" className="mr-1.5 inline size-4" />
                  )}
                  {copied ? "Copied" : "Copy URL"}
                </button>
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  disabled={busy}
                  onClick={() => void rotateHook()}
                >
                  Regenerate URL
                </button>
              </div>
              <p aria-live="polite" className="sr-only">
                {copied ? "Webhook URL copied to the clipboard." : ""}
              </p>
            </>
          )}
        </section>
      ) : null}

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
        <p role="alert" className="text-[14px] text-[var(--personal-error)]">
          {actionError}
        </p>
      ) : null}

      <section>
        <h3 className="mb-1 text-[13px] font-semibold text-[var(--personal-section-label)] uppercase">
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
