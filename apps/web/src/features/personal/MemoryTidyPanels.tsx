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
import { SelectCheck } from "./SelectMode";
import {
  memoryDayTimeLabel,
  memoryMetaLine,
  newestTidyRunsFirst,
  pendingTidyChanges,
  pendingTidyGroups,
  reclassifyDescription,
  rescopeDescription,
  memoryReachTag,
  splitPartTag,
  supersedeKeptText,
  TIDY_CHANGE_STATUS_LABEL,
  TIDY_MODE_LABEL,
  tidyActionLabel,
  tidyProvenanceLabel,
  tidyRequestHeadline,
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
  personalMemoryTidyUndo,
  usePersonalMemoryTidyLog,
} from "./usePersonalAutomation";

type BotName = (botId: string) => string | undefined;

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

/** "Showing 100 of 733" with a button for the next page of a long list. */
export function ShowMoreButton({
  shown,
  total,
  onClick,
}: {
  shown: number;
  total: number;
  onClick: () => void;
}): JSX.Element {
  return (
    <div className="mt-2 flex flex-col items-start gap-1">
      <p className="text-[13px] text-[var(--personal-text-secondary)]">
        Showing {shown} of {total}
      </p>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] px-5 text-[15px] font-semibold text-[var(--personal-text)]",
          FOCUS_RING,
        )}
      >
        Show more
      </button>
    </div>
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
  total,
  searching,
  onShowMore,
  loadError,
  scopeOf,
  now,
}: {
  environmentId: EnvironmentId | null;
  /** The newest archived entries that match the screen's search (the server searches all of them). */
  entries: ReadonlyArray<PersonalMemoryEntry> | null;
  /** How many archived entries match in all; more than `entries` until "Show more" has loaded them. */
  total: number;
  /** A search is narrowing the list. */
  searching: boolean;
  onShowMore: () => void;
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
        title={`Archived (${entries === null ? "…" : total})`}
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
            {searching
              ? "No archived memory matches that search."
              : "Nothing archived. When a fact changes, or a bot is asked to forget something, the older entry moves here."}
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
        {entries !== null && shown.length < total ? (
          <ShowMoreButton shown={shown.length} total={total} onClick={onShowMore} />
        ) : null}
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

const SUBHEAD = "mt-1.5 text-[12px] font-medium text-[var(--personal-text-tertiary)]";

/** One change in a run: what it did, why, and the entries involved. */
export function TidyChangeItem({
  change,
  texts,
  botName,
  leading,
  children,
}: {
  change: PersonalMemoryTidyChange;
  texts: ReadonlyMap<string, string>;
  botName: BotName;
  /** A checkbox, in the waiting list. */
  leading?: ReactNode;
  /** Approve / Reject, in the waiting list. */
  children?: ReactNode;
}): JSX.Element {
  const involved = tidyEntryTexts(change.memoryIds, texts);
  const reclassify = change.action === "reclassify" ? reclassifyDescription(change) : "";
  const rescope = rescopeDescription(change);
  // A rescope shows the whole rule it applies to: the owner approves exactly this text.
  const clamp = change.action === "rescope" ? "" : "line-clamp-3 ";
  const headline = tidyRequestHeadline(change, botName);
  // Provenance only where the owner decides: the changelog's runs say where they came from.
  const provenance =
    change.status === "pending" ? tidyProvenanceLabel(change.proposedBy, botName) : null;
  // A supersede or split archives memoryIds; a supersede with no result is a retirement.
  const kept = change.action === "supersede" ? supersedeKeptText(change, texts) : null;
  const parts = change.action === "split" ? (change.parts ?? []) : [];
  const archives = change.action === "supersede" || change.action === "split";
  // What the owner's answer is bound to, per entry (none on older changes).
  const boundTo = (memoryId: string) => change.bound?.find((entry) => entry.memoryId === memoryId);
  const keptBound = change.resultMemoryId === null ? undefined : boundTo(change.resultMemoryId);
  return (
    <li className="flex items-start gap-1 py-2.5">
      {leading}
      <div className="min-w-0 flex-1">
        <p className="text-[14px] text-[var(--personal-text)]">
          <span className="font-semibold">{tidyActionLabel(change)}</span>
          <span className="text-[var(--personal-text-secondary)]">
            {" "}
            · {TIDY_CHANGE_STATUS_LABEL[change.status]}
          </span>
        </p>
        {provenance !== null ? (
          <p className="text-[12px] text-[var(--personal-text-tertiary)]">{provenance}</p>
        ) : null}
        {headline !== "" ? (
          <p className="mt-0.5 text-[14px] font-medium text-[var(--personal-text)]">{headline}</p>
        ) : null}
        {change.action === "save" && change.content !== null ? (
          <p className="mt-1 text-[14px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text)]">
            {change.content}
          </p>
        ) : null}
        {reclassify !== "" ? (
          <p className="mt-0.5 text-[14px] font-medium text-[var(--personal-text)]">{reclassify}</p>
        ) : null}
        {rescope !== "" ? (
          <p className="mt-0.5 text-[14px] font-medium text-[var(--personal-text)]">{rescope}</p>
        ) : null}
        {change.reason.trim().length > 0 ? (
          <p className="mt-0.5 text-[13px] leading-snug text-[var(--personal-text-secondary)]">
            {change.reason}
          </p>
        ) : null}
        {change.action === "save" && involved.length > 0 ? (
          <p className={SUBHEAD}>Would replace</p>
        ) : null}
        {archives && involved.length > 0 ? <p className={SUBHEAD}>Archives</p> : null}
        {change.action === "rescope" && involved.length > 0 ? (
          <p className={SUBHEAD}>The rule</p>
        ) : null}
        {involved.length > 0 ? (
          <ul className="mt-1.5 flex flex-col gap-1">
            {involved.map((text, index) => (
              <li
                // oxlint-disable-next-line react/no-array-index-key -- ids can repeat; order is the data
                key={index}
                className="border-l-2 border-[var(--personal-border)] pl-2"
              >
                <p
                  className={cn(
                    clamp,
                    "text-[13px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text-secondary)]",
                  )}
                >
                  {text}
                </p>
                {/* Its own line, outside the clamp: a long entry never hides it. */}
                {(() => {
                  const bound = boundTo(change.memoryIds[index] ?? "");
                  return bound === undefined || bound.textOnly ? null : (
                    <p className="mt-0.5 text-[12px] leading-snug text-[var(--personal-text-tertiary)]">
                      {`Bound to: ${memoryReachTag(bound)}`}
                    </p>
                  );
                })()}
              </li>
            ))}
          </ul>
        ) : null}
        {kept !== null ? (
          <div className="mt-1.5">
            <p className="text-[12px] font-medium text-[var(--personal-text-tertiary)]">
              Keeps (newer)
            </p>
            <p className="mt-0.5 text-[14px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text)]">
              {kept}
            </p>
            {keptBound?.textOnly === true ? (
              <p className="text-[12px] text-[var(--personal-text-tertiary)]">
                Bound to its text; its reach may change before you answer.
              </p>
            ) : null}
          </div>
        ) : null}
        {parts.length > 0 ? (
          <div className="mt-1.5">
            <p className="text-[12px] font-medium text-[var(--personal-text-tertiary)]">
              {`Split into (${parts.length})`}
            </p>
            <ul className="mt-0.5 flex flex-col gap-1.5">
              {parts.map((part, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- parts have no id; order is the data
                <li key={index} className="min-w-0">
                  <p className="text-[14px] leading-snug break-words whitespace-pre-wrap text-[var(--personal-text)]">
                    {part.content}
                  </p>
                  <p className="text-[12px] text-[var(--personal-text-secondary)]">
                    {splitPartTag(part)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
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
      </div>
    </li>
  );
}

type DecideBusy =
  | { readonly kind: "one"; readonly changeId: number; readonly approve: boolean }
  | { readonly kind: "group"; readonly runId: string; readonly approve: boolean };

const DECIDE_BUTTON =
  "h-11 rounded-[var(--personal-radius-button)] px-4 text-[15px] font-semibold disabled:opacity-60";
const APPROVE_LOOK = "bg-[var(--personal-primary)] text-[var(--personal-primary-text)]";
const REJECT_LOOK = "bg-[var(--personal-fill-muted)] text-[var(--personal-text)]";

const withoutId = (current: ReadonlySet<number>, changeId: number): ReadonlySet<number> => {
  const next = new Set(current);
  next.delete(changeId);
  return next;
};

/**
 * Changes the tidy-up will not make without the owner's OK, grouped by run.
 * Each has Approve and Reject; ticked ones can be decided together per group.
 */
function PendingTidyChanges({
  environmentId,
  groups,
  texts,
  botName,
}: {
  environmentId: EnvironmentId | null;
  groups: ReadonlyArray<{
    readonly runId: string;
    readonly label: string;
    readonly changes: ReadonlyArray<PersonalMemoryTidyChange>;
  }>;
  texts: ReadonlyMap<string, string>;
  botName: BotName;
}): JSX.Element {
  const decide = useAtomCommand(personalMemoryTidyDecide);
  const [busy, setBusy] = useState<DecideBusy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const hashById = useMemo(() => {
    const hashes = new Map<number, string>();
    for (const group of groups) {
      for (const change of group.changes) {
        hashes.set(change.changeId, change.changeHash);
      }
    }
    return hashes;
  }, [groups]);

  const decideOne = async (changeId: number, approve: boolean) => {
    if (environmentId === null) return "No connection.";
    // The hash binds the tap to the change on screen; the server refuses a stale one.
    const changeHash = hashById.get(changeId);
    if (changeHash === undefined) return "That change is no longer listed; reload and try again.";
    const result = await decide({ environmentId, input: { changeId, approve, changeHash } });
    const message = commandFailureMessage(
      result,
      approve ? "Could not approve that change." : "Could not reject that change.",
    );
    if (message === null) setSelected((current) => withoutId(current, changeId));
    return message;
  };

  const onDecide = async (changeId: number, approve: boolean) => {
    if (environmentId === null || busy !== null) return;
    setBusy({ kind: "one", changeId, approve });
    setError(null);
    const message = await decideOne(changeId, approve);
    setBusy(null);
    setError(message);
  };

  // One decide per ticked change, in order; the first failure stops the rest.
  const onDecideGroup = async (
    runId: string,
    changeIds: ReadonlyArray<number>,
    approve: boolean,
  ) => {
    if (environmentId === null || busy !== null || changeIds.length === 0) return;
    setBusy({ kind: "group", runId, approve });
    setError(null);
    for (const changeId of changeIds) {
      const message = await decideOne(changeId, approve);
      if (message !== null) {
        setError(message);
        break;
      }
    }
    setBusy(null);
  };

  return (
    <div>
      {error !== null ? (
        <p role="alert" className="mt-1 text-[14px] text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}
      {groups.map((group) => {
        const ids = group.changes.map((change) => change.changeId);
        const chosen = ids.filter((changeId) => selected.has(changeId));
        const all = chosen.length === ids.length;
        const groupBusy = busy?.kind === "group" && busy.runId === group.runId;
        return (
          <section
            key={group.runId}
            aria-label={group.label}
            className="mt-2 border-t border-[var(--personal-border)] pt-2"
          >
            <h3 className="text-[14px] font-semibold text-[var(--personal-text)]">
              {group.label} ({ids.length})
            </h3>
            <button
              type="button"
              role="checkbox"
              aria-checked={all ? true : chosen.length > 0 ? "mixed" : false}
              disabled={busy !== null}
              onClick={() =>
                setSelected((current) => {
                  const next = new Set(current);
                  for (const changeId of ids) {
                    if (all) next.delete(changeId);
                    else next.add(changeId);
                  }
                  return next;
                })
              }
              className={cn(
                "flex min-h-11 items-center gap-2.5 rounded-[var(--personal-radius-button)] text-[14px] font-medium text-[var(--personal-text)] disabled:opacity-60",
                FOCUS_RING,
              )}
            >
              <SelectCheck checked={all} />
              Select all in this group
            </button>
            <ul className="divide-y divide-[var(--personal-border)]">
              {group.changes.map((change) => {
                const mine = busy?.kind === "one" && busy.changeId === change.changeId;
                const ticked = selected.has(change.changeId);
                return (
                  <TidyChangeItem
                    key={change.changeId}
                    change={change}
                    texts={texts}
                    botName={botName}
                    leading={
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={ticked}
                        aria-label="Select this change"
                        disabled={busy !== null}
                        onClick={() =>
                          setSelected((current) =>
                            current.has(change.changeId)
                              ? withoutId(current, change.changeId)
                              : new Set([...current, change.changeId]),
                          )
                        }
                        className={cn(
                          "-my-2.5 -ml-2.5 flex size-11 shrink-0 items-center justify-center rounded-full disabled:opacity-60",
                          FOCUS_RING,
                        )}
                      >
                        <SelectCheck checked={ticked} />
                      </button>
                    }
                  >
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        disabled={busy !== null}
                        aria-busy={mine && busy.approve}
                        onClick={() => void onDecide(change.changeId, true)}
                        className={cn(DECIDE_BUTTON, APPROVE_LOOK, FOCUS_RING)}
                      >
                        {mine && busy.approve ? "Approving…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        aria-busy={mine && !busy.approve}
                        onClick={() => void onDecide(change.changeId, false)}
                        className={cn(DECIDE_BUTTON, REJECT_LOOK, FOCUS_RING)}
                      >
                        {mine && !busy.approve ? "Rejecting…" : "Reject"}
                      </button>
                    </div>
                  </TidyChangeItem>
                );
              })}
            </ul>
            <div className="flex flex-wrap gap-2 py-2">
              <button
                type="button"
                disabled={busy !== null || chosen.length === 0}
                aria-busy={groupBusy && busy.approve}
                onClick={() => void onDecideGroup(group.runId, chosen, true)}
                className={cn(DECIDE_BUTTON, APPROVE_LOOK, FOCUS_RING)}
              >
                {groupBusy && busy.approve ? "Approving…" : `Approve selected (${chosen.length})`}
              </button>
              <button
                type="button"
                disabled={busy !== null || chosen.length === 0}
                aria-busy={groupBusy && !busy.approve}
                onClick={() => void onDecideGroup(group.runId, chosen, false)}
                className={cn(DECIDE_BUTTON, REJECT_LOOK, FOCUS_RING)}
              >
                {groupBusy && !busy.approve ? "Rejecting…" : `Reject selected (${chosen.length})`}
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * "Waiting for your OK (N)": every change a bot or the tidy-up asked for, the
 * first section under the Memory screen's intro, open whenever something is
 * waiting (the owner can still fold it).
 */
export function MemoryWaitingSection({
  environmentId,
  texts,
  botName,
}: {
  environmentId: EnvironmentId | null;
  /** memoryId to text, from the current and archived lists. */
  texts: ReadonlyMap<string, string>;
  botName: BotName;
}): JSX.Element | null {
  const log = usePersonalMemoryTidyLog(environmentId);
  const groups = useMemo(
    () => pendingTidyGroups(newestTidyRunsFirst(log.data?.runs ?? [])),
    [log.data],
  );
  const total = groups.reduce((sum, group) => sum + group.changes.length, 0);
  // null: follow the count (open when something waits) until the owner taps.
  const [openChoice, setOpenChoice] = useState<boolean | null>(null);
  const open = openChoice ?? total > 0;
  const panelId = useId();
  // Changes are made on their own now (each with an Undo in the changelog): nothing to show
  // unless some still wait for an answer (the automatic mode switched off).
  if (log.data === null || total === 0) return null;
  return (
    <section
      aria-label="Waiting for your OK"
      className="mt-4 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] px-3"
    >
      <Disclosure
        title={`Waiting for your OK (${total})`}
        detail={
          total === 0
            ? "Nothing is waiting."
            : "Rules and changes bots asked for. Nothing changes until you approve it."
        }
        open={open}
        onToggle={() => setOpenChoice(!open)}
        controls={panelId}
      />
      <div id={panelId} hidden={!open} className="pb-1">
        {total > 0 ? (
          <PendingTidyChanges
            environmentId={environmentId}
            groups={groups}
            texts={texts}
            botName={botName}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * Undo for a change that was made on its own (or approved): the entries it archived come back,
 * what it made is archived, a rescope is put back. The tap is bound to the change on screen.
 */
function UndoChangeButton({
  environmentId,
  change,
}: {
  environmentId: EnvironmentId | null;
  change: PersonalMemoryTidyChange;
}): JSX.Element | null {
  const undo = useAtomCommand(personalMemoryTidyUndo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (change.undoable !== true) return null;
  const onUndo = async () => {
    if (environmentId === null || busy) return;
    setBusy(true);
    setError(null);
    const result = await undo({
      environmentId,
      input: { changeId: change.changeId, changeHash: change.changeHash },
    });
    setBusy(false);
    setError(commandFailureMessage(result, "Could not undo that change."));
  };
  return (
    <div className="mt-1.5">
      <button
        type="button"
        disabled={environmentId === null || busy}
        aria-busy={busy}
        onClick={() => void onUndo()}
        className={cn(
          "h-11 rounded-[var(--personal-radius-button)] bg-[var(--personal-fill-muted)] px-4 text-[15px] font-semibold text-[var(--personal-text)] disabled:opacity-60",
          FOCUS_RING,
        )}
      >
        {busy ? "Undoing…" : "Undo"}
      </button>
      {error !== null ? (
        <p role="alert" className="mt-1 text-[14px] text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One run in the changelog, with its changes folded behind a button. */
function TidyRunItem({
  environmentId,
  run,
  texts,
  botName,
}: {
  environmentId: EnvironmentId | null;
  run: PersonalMemoryTidyRun;
  texts: ReadonlyMap<string, string>;
  botName: BotName;
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
              <TidyChangeItem key={change.changeId} change={change} texts={texts} botName={botName}>
                <UndoChangeButton environmentId={environmentId} change={change} />
              </TidyChangeItem>
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
  botName,
}: {
  environmentId: EnvironmentId | null;
  /** memoryId to text, from the current and archived lists. */
  texts: ReadonlyMap<string, string>;
  botName: BotName;
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
        <p className="text-[14px] leading-snug text-[var(--personal-text-secondary)]">
          Each night at 03:30 duplicates are merged and outdated entries are replaced. The changes
          are made at once, and each one is in the changelog below with an Undo. Preview only lists
          what it would do and changes nothing.
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
              <TidyRunItem
                key={run.runId}
                environmentId={environmentId}
                run={run}
                texts={texts}
                botName={botName}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
