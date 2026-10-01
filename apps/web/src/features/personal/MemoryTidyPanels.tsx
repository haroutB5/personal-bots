import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useId, useMemo, useRef, useState } from "react";

import type {
  EnvironmentId,
  PersonalMemoryEntry,
  PersonalMemoryTidyChange,
  PersonalMemoryTidyMode,
  PersonalMemoryTidyRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { ChevronDown } from "lucide-react";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import { MemoryContent } from "./MemoryContent";
import {
  memoryDayTimeLabel,
  memoryMetaLine,
  newestTidyRunsFirst,
  pendingTidyChanges,
  TIDY_CHANGE_STATUS_LABEL,
  TIDY_ACTION_LABEL,
  TIDY_MODE_LABEL,
  TIDY_MODES,
  tidyChangeCountLabel,
  tidyCountsLabel,
  tidyEntryTexts,
  tidyRunKindLabel,
  tidyStatusLabel,
  tidySummaryLine,
} from "./memoryPresentation";
import {
  personalMemoryRestore,
  personalMemoryTidyDecide,
  personalMemoryTidyRun,
  personalMemoryTidySetMode,
  usePersonalMemoryTidyLog,
} from "./usePersonalAutomation";

const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--personal-surface)]";

/** A section header that opens and closes the section below it. */
function Disclosure({
  title,
  detail,
  open,
  onToggle,
  controls,
}: {
  title: string;
  detail?: string;
  open: boolean;
  onToggle: () => void;
  controls: string;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "flex min-h-11 w-full items-center gap-2 rounded-[var(--personal-radius-button)] py-2 text-left",
        FOCUS_RING,
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-semibold text-[var(--personal-text)]">{title}</span>
        {detail === undefined ? null : (
          <span className="mt-0.5 block text-[13px] leading-snug text-[var(--personal-text-secondary)]">
            {detail}
          </span>
        )}
      </span>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-5 shrink-0 text-[var(--personal-text-secondary)] transition-transform",
          open && "rotate-180",
        )}
        strokeWidth={1.75}
      />
    </button>
  );
}

/** One archived entry: what it said, why it was archived, and Restore. */
function ArchivedRow({
  entry,
  scope,
  now,
  busy,
  onRestore,
}: {
  entry: PersonalMemoryEntry;
  scope: string;
  now: number;
  busy: boolean;
  onRestore: (entry: PersonalMemoryEntry) => void;
}): JSX.Element {
  const archivedAt = DateTime.toEpochMillis(entry.supersededAt ?? entry.updatedAt);
  return (
    <li className="flex flex-col gap-1 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded-[var(--personal-radius-pill)] bg-[var(--personal-fill-muted)] px-2 py-0.5 text-[12px] font-medium text-[var(--personal-text)]">
          {scope}
        </span>
      </div>
      <MemoryContent content={entry.content} />
      <p className="text-[13px] leading-snug text-[var(--personal-text-secondary)]">
        {entry.supersededReason?.trim() || "Archived"}
      </p>
      <p className="text-[12px] text-[var(--personal-text-tertiary)]">
        {memoryMetaLine("Archived", archivedAt, now)}
      </p>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => onRestore(entry)}
        className={cn(
          "mt-1 h-11 self-start rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] px-5 text-[15px] font-semibold text-[var(--personal-text)] disabled:opacity-40",
          FOCUS_RING,
        )}
      >
        {busy ? "Restoring…" : "Restore"}
      </button>
    </li>
  );
}

/**
 * Entries a newer save replaced, a bot was asked to forget, or the tidy-up
 * archived. Bots never receive them;
 * Restore puts one back. Closed by default, below the current list.
 */
export function ArchivedMemorySection({
  environmentId,
  entries,
  totalCount,
  loadError,
  scopeOf,
  now,
}: {
  environmentId: EnvironmentId | null;
  /** Already narrowed by the screen's search. */
  entries: ReadonlyArray<PersonalMemoryEntry> | null;
  totalCount: number;
  loadError: string | null;
  scopeOf: (entry: PersonalMemoryEntry) => string;
  now: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const restore = useAtomCommand(personalMemoryRestore);
  const panelId = useId();
  const shown = entries ?? [];

  const onRestore = async (entry: PersonalMemoryEntry) => {
    if (environmentId === null || busyId !== null) return;
    setBusyId(entry.memoryId);
    setError(null);
    const result = await restore({ environmentId, input: { memoryId: entry.memoryId } });
    setBusyId(null);
    setError(commandFailureMessage(result, "Could not restore that memory."));
  };

  return (
    <section className="mt-6 border-t border-[var(--personal-border)] pt-2">
      <Disclosure
        title={`Archived (${entries === null ? "…" : shown.length})`}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        controls={panelId}
      />
      <div id={panelId} hidden={!open}>
        {error !== null ? (
          <p role="alert" className="mt-1 text-[14px] text-[var(--personal-error)]">
            {error}
          </p>
        ) : null}
        {entries === null ? (
          <p className="mt-2 text-[14px] text-[var(--personal-text-secondary)]">
            {loadError ?? "Loading…"}
          </p>
        ) : shown.length === 0 ? (
          <p className="mt-2 text-[14px] text-[var(--personal-text-secondary)]">
            {totalCount === 0
              ? "Nothing archived. When a fact changes, or a bot is asked to forget something, the older entry moves here."
              : "No archived memory matches that search."}
          </p>
        ) : (
          <ul className="divide-y divide-[var(--personal-border)]">
            {shown.map((entry) => (
              <ArchivedRow
                key={entry.memoryId}
                entry={entry}
                scope={scopeOf(entry)}
                now={now}
                busy={busyId === entry.memoryId}
                onRestore={(target) => void onRestore(target)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Off / Preview only / Make changes, as a segmented radio group (arrow keys move it). */
function TidyModeControl({
  mode,
  disabled,
  onChange,
}: {
  mode: PersonalMemoryTidyMode | null;
  disabled: boolean;
  onChange: (mode: PersonalMemoryTidyMode) => void;
}): JSX.Element {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + TIDY_MODES.length) % TIDY_MODES.length;
    buttons.current[next]?.focus();
    onChange(TIDY_MODES[next]!);
  };
  return (
    <div
      role="radiogroup"
      aria-label="Nightly tidy-up"
      className="flex gap-1 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] p-1"
    >
      {TIDY_MODES.map((candidate, index) => {
        const selected = candidate === mode;
        return (
          <button
            key={candidate}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected || (mode === null && index === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(candidate)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "min-h-11 flex-1 rounded-[calc(var(--personal-radius-button)-2px)] px-1 text-[14px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--personal-text)] disabled:opacity-60",
              selected
                ? "bg-[var(--personal-primary)] font-semibold text-[var(--personal-primary-text)]"
                : "text-[var(--personal-text-secondary)]",
            )}
          >
            {TIDY_MODE_LABEL[candidate]}
          </button>
        );
      })}
    </div>
  );
}

/** One change in a run: what it did, why, and the entries involved. */
function TidyChangeItem({
  change,
  texts,
  children,
}: {
  change: PersonalMemoryTidyChange;
  texts: ReadonlyMap<string, string>;
  /** Approve / Reject, in the waiting list. */
  children?: ReactNode;
}): JSX.Element {
  const involved = tidyEntryTexts(change.memoryIds, texts);
  return (
    <li className="py-2.5">
      <p className="text-[14px] text-[var(--personal-text)]">
        <span className="font-semibold">{TIDY_ACTION_LABEL[change.action]}</span>
        <span className="text-[var(--personal-text-secondary)]">
          {" "}
          · {TIDY_CHANGE_STATUS_LABEL[change.status]}
        </span>
      </p>
      {change.reason.trim().length > 0 ? (
        <p className="mt-0.5 text-[13px] leading-snug text-[var(--personal-text-secondary)]">
          {change.reason}
        </p>
      ) : null}
      {involved.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-1">
          {involved.map((text, index) => (
            <li
              // oxlint-disable-next-line react/no-array-index-key -- ids can repeat; order is the data
              key={index}
              className="line-clamp-3 border-l-2 border-[var(--personal-border)] pl-2 text-[13px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text-secondary)]"
            >
              {text}
            </li>
          ))}
        </ul>
      ) : null}
      {change.action === "merge" && change.content !== null ? (
        <div className="mt-1.5">
          <p className="text-[12px] font-medium text-[var(--personal-text-tertiary)]">
            Merged text
          </p>
          <p className="mt-0.5 text-[14px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text)]">
            {change.content}
          </p>
        </div>
      ) : null}
      {children}
    </li>
  );
}

/** Changes the tidy-up will not make without the owner's OK, with Approve and Reject. */
function PendingTidyChanges({
  environmentId,
  changes,
  texts,
}: {
  environmentId: EnvironmentId | null;
  changes: ReadonlyArray<PersonalMemoryTidyChange>;
  texts: ReadonlyMap<string, string>;
}): JSX.Element {
  const decide = useAtomCommand(personalMemoryTidyDecide);
  const [busy, setBusy] = useState<{ changeId: number; approve: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onDecide = async (changeId: number, approve: boolean) => {
    if (environmentId === null || busy !== null) return;
    setBusy({ changeId, approve });
    setError(null);
    const result = await decide({ environmentId, input: { changeId, approve } });
    setBusy(null);
    setError(
      commandFailureMessage(
        result,
        approve ? "Could not approve that change." : "Could not reject that change.",
      ),
    );
  };

  return (
    <div className="rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] px-3 py-2">
      <h2 className="text-[15px] font-semibold text-[var(--personal-text)]">
        Waiting for your OK ({changes.length})
      </h2>
      {error !== null ? (
        <p role="alert" className="mt-1 text-[14px] text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}
      <ul className="divide-y divide-[var(--personal-border)]">
        {changes.map((change) => {
          const mine = busy?.changeId === change.changeId;
          return (
            <TidyChangeItem key={change.changeId} change={change} texts={texts}>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  aria-busy={mine && busy?.approve === true}
                  onClick={() => void onDecide(change.changeId, true)}
                  className={cn(
                    "h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-5 text-[15px] font-semibold text-[var(--personal-primary-text)] disabled:opacity-60",
                    FOCUS_RING,
                  )}
                >
                  {mine && busy?.approve === true ? "Approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  aria-busy={mine && busy?.approve === false}
                  onClick={() => void onDecide(change.changeId, false)}
                  className={cn(
                    "h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] px-5 text-[15px] font-semibold text-[var(--personal-text)] disabled:opacity-60",
                    FOCUS_RING,
                  )}
                >
                  {mine && busy?.approve === false ? "Rejecting…" : "Reject"}
                </button>
              </div>
            </TidyChangeItem>
          );
        })}
      </ul>
    </div>
  );
}

/** One run in the changelog, with its changes folded behind a button. */
function TidyRunItem({
  run,
  texts,
}: {
  run: PersonalMemoryTidyRun;
  texts: ReadonlyMap<string, string>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const changesId = useId();
  return (
    <li className="py-3">
      <p className="text-[14px] font-semibold text-[var(--personal-text)]">
        {memoryDayTimeLabel(DateTime.toEpochMillis(run.startedAt))}
      </p>
      <p className="mt-0.5 text-[13px] text-[var(--personal-text-secondary)]">
        {tidyRunKindLabel(run)} · {tidyStatusLabel(run.status)}
        {run.status === "done" ? ` · ${tidyCountsLabel(run)}` : ""}
      </p>
      {run.error !== null ? (
        <p className="mt-1 text-[13px] break-words text-[var(--personal-error)]">{run.error}</p>
      ) : null}
      {run.changes.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={changesId}
            onClick={() => setOpen((value) => !value)}
            className={cn(
              "-mb-1 min-h-11 rounded-[var(--personal-radius-button)] text-[14px] font-medium text-[var(--personal-text)] underline underline-offset-2",
              FOCUS_RING,
            )}
          >
            {open ? "Hide changes" : `Show ${tidyChangeCountLabel(run.changes.length)}`}
          </button>
          <ul id={changesId} hidden={!open} className="divide-y divide-[var(--personal-border)]">
            {run.changes.map((change) => (
              <TidyChangeItem key={change.changeId} change={change} texts={texts} />
            ))}
          </ul>
        </>
      ) : null}
    </li>
  );
}

/**
 * The nightly tidy-up (03:30): its mode, a Preview now button, and the
 * changelog of recent runs. Closed by default.
 */
export function MemoryTidySection({
  environmentId,
  texts,
}: {
  environmentId: EnvironmentId | null;
  /** memoryId to text, from the current and archived lists. */
  texts: ReadonlyMap<string, string>;
}): JSX.Element {
  const log = usePersonalMemoryTidyLog(environmentId);
  const setModeCommand = useAtomCommand(personalMemoryTidySetMode);
  const runCommand = useAtomCommand(personalMemoryTidyRun);
  const [open, setOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<PersonalMemoryTidyMode | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();

  const runs = useMemo(() => newestTidyRunsFirst(log.data?.runs ?? []), [log.data]);
  const waiting = useMemo(() => pendingTidyChanges(runs), [runs]);
  const mode = pendingMode ?? log.data?.mode ?? null;
  const summary =
    log.data === null
      ? (log.error ?? "Loading…")
      : tidySummaryLine(log.data.mode, runs[0] ?? null, waiting.length);

  const onModeChange = async (next: PersonalMemoryTidyMode) => {
    if (environmentId === null || pendingMode !== null || next === log.data?.mode) return;
    setPendingMode(next);
    setError(null);
    const result = await setModeCommand({ environmentId, input: { mode: next } });
    setPendingMode(null);
    setError(commandFailureMessage(result, "Could not change the tidy-up setting."));
  };

  const onPreview = async () => {
    if (environmentId === null || previewing) return;
    setPreviewing(true);
    setError(null);
    const result = await runCommand({ environmentId, input: { dryRun: true } });
    setPreviewing(false);
    setError(commandFailureMessage(result, "Could not run the preview."));
  };

  return (
    <section className="mt-2 border-t border-[var(--personal-border)] pt-2">
      <Disclosure
        title="Nightly tidy-up"
        detail={summary}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        controls={panelId}
      />
      <div id={panelId} hidden={!open} className="flex flex-col gap-3 pt-1">
        {waiting.length > 0 ? (
          <PendingTidyChanges environmentId={environmentId} changes={waiting} texts={texts} />
        ) : null}
        <p className="text-[14px] leading-snug text-[var(--personal-text-secondary)]">
          Each night at 03:30 duplicates are merged and outdated entries are replaced. Preview only
          lists what it would do and changes nothing. Changes that need your OK wait at the top.
        </p>
        <TidyModeControl
          mode={mode}
          disabled={environmentId === null || log.data === null || pendingMode !== null}
          onChange={(next) => void onModeChange(next)}
        />
        <button
          type="button"
          disabled={environmentId === null || previewing}
          aria-busy={previewing}
          onClick={() => void onPreview()}
          className={cn(
            "h-11 self-start rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-5 text-[15px] font-semibold text-[var(--personal-primary-text)] disabled:opacity-60",
            FOCUS_RING,
          )}
        >
          {previewing ? "Previewing…" : "Preview now"}
        </button>
        <p aria-live="polite" className="-mt-1 text-[13px] text-[var(--personal-text-secondary)]">
          {previewing ? "This can take a minute. Nothing is changed." : ""}
        </p>
        {error !== null ? (
          <p role="alert" className="text-[14px] text-[var(--personal-error)]">
            {error}
          </p>
        ) : null}
        <h2 className="text-[15px] font-semibold text-[var(--personal-text)]">Changelog</h2>
        {log.data === null ? (
          <p className="text-[14px] text-[var(--personal-text-secondary)]">
            {log.error ?? "Loading…"}
          </p>
        ) : runs.length === 0 ? (
          <p className="text-[14px] text-[var(--personal-text-secondary)]">No runs yet.</p>
        ) : (
          <ul className="-mt-2 divide-y divide-[var(--personal-border)]">
            {runs.map((run) => (
              <TidyRunItem key={run.runId} run={run} texts={texts} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
