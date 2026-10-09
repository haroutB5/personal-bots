import type { JSX } from "react";
import { useId, useState } from "react";

import {
  type EnvironmentId,
  type PersonalMemoryFeedbackSignal,
  type PersonalMemoryTurnContext,
} from "@t3tools/contracts";
import { ChevronDown } from "lucide-react";

import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";

import { commandFailureMessage } from "./commandFeedback";
import {
  appChipLabel,
  contextUsedSummary,
  feedbackLabel,
  nextFeedback,
  noteKindLabel,
  rulesHeadline,
} from "./contextUsed";
import { appsLabel, plainMemoryText } from "./memoryPresentation";
import { personalMemoryFeedback, usePersonalMemoryTurnContext } from "./usePersonalAutomation";

const SECTION_LABEL =
  "text-[12px] font-semibold tracking-wide text-[var(--personal-text-secondary)] uppercase";
/** What the panel says for a note picked on its keywords alone. */
const MATCHED_WORDS = "matched words";

const CHIP =
  "rounded-[var(--personal-radius-pill)] bg-[var(--personal-fill-muted)] px-2 py-0.5 text-[12px] text-[var(--personal-text-secondary)]";
const MARK_BUTTON =
  "min-h-9 rounded-[var(--personal-radius-button)] border px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:opacity-70 disabled:opacity-40";

/**
 * The owner's view of one turn's memory: which rules applied and why, which
 * notes and summaries were given and why they matched, what was left out, and
 * "Outdated" / "Not relevant" marks that rank a note lower next time (never
 * deleting it). Pure: the connected {@link ContextUsed} feeds it.
 */
export function ContextUsedView({
  context,
  marks,
  busyId,
  onMark,
  readOnly = false,
  error = null,
}: {
  context: PersonalMemoryTurnContext;
  /** Marks set in this view, over what the server held when it was read. */
  marks: ReadonlyMap<string, PersonalMemoryFeedbackSignal | null>;
  busyId: string | null;
  onMark: (memoryId: string, signal: PersonalMemoryFeedbackSignal | "clear") => void;
  /** An archived chat: the view reads, nothing can be marked. */
  readOnly?: boolean;
  error?: string | null;
}): JSX.Element {
  const markOf = (memoryId: string, held: PersonalMemoryFeedbackSignal | null) =>
    marks.has(memoryId) ? (marks.get(memoryId) ?? null) : held;
  return (
    <div data-testid="context-used-view" className="mt-2 flex flex-col gap-3.5">
      {context.apps.length > 0 ? (
        <section aria-label="What the turn was about">
          <p className={SECTION_LABEL}>About</p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {context.apps.map((app) => (
              <li key={app.slug} className={CHIP}>
                {appChipLabel(app)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="Rules">
        <p className={SECTION_LABEL}>Rules</p>
        <p className="mt-1 text-[14px] leading-snug text-[var(--personal-text)]">
          {rulesHeadline(context.rules)}
          {context.rules.added.length > 0
            ? ` ${context.rules.added.length} ${context.rules.added.length === 1 ? "rule was" : "rules were"} added because the chat started covering another app.`
            : ""}
        </p>
        {context.rules.items.length > 0 ? (
          <details className="mt-1">
            <summary className="min-h-9 cursor-pointer py-1.5 text-[13px] font-medium text-[var(--personal-text-secondary)] select-none">
              Show the rules
            </summary>
            <ul className="flex flex-col gap-1.5">
              {context.rules.items.map((rule) => (
                <li
                  key={rule.memoryId}
                  className="border-l-2 border-[var(--personal-border)] pl-2 text-[13px] leading-snug break-words text-[var(--personal-text)]"
                >
                  {rule.current
                    ? plainMemoryText(rule.content)
                    : "(replaced or forgotten since this turn)"}
                  <span className="mt-1 block text-xs break-words">{rule.provenance}</span>
                  {rule.apps !== null && rule.apps.length > 0 ? (
                    <span className="mt-0.5 block text-[12px] text-[var(--personal-text-tertiary)]">
                      Only: {appsLabel(rule.apps)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {context.rules.index !== null ? (
          <p className="mt-1 text-[12px] leading-snug text-[var(--personal-text-secondary)]">
            Not listed, for other apps: {context.rules.index}. The bot can read them with
            search_memory.
          </p>
        ) : null}
        {context.rules.leftOut.length > 0 ? (
          <div className="mt-1.5">
            <p className="text-[12px] font-medium text-[var(--personal-text)]">
              Did not fit the limit, named to the bot:
            </p>
            <ul className="mt-0.5 flex flex-col gap-1">
              {context.rules.leftOut.map((rule) => (
                <li
                  key={rule.memoryId}
                  className="border-l-2 border-[var(--personal-border)] pl-2 text-[13px] leading-snug break-words text-[var(--personal-text-secondary)]"
                >
                  {plainMemoryText(rule.content)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-label="Notes and task summaries">
        <p className={SECTION_LABEL}>Notes and task summaries</p>
        {context.notes.length === 0 ? (
          <p className="mt-1 text-[14px] text-[var(--personal-text-secondary)]">
            None matched this turn.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2.5">
            {context.notes.map((note) => {
              const mark = markOf(note.memoryId, note.feedback);
              const busy = busyId === note.memoryId;
              return (
                <li
                  key={note.memoryId}
                  data-testid="context-note"
                  className="rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] px-3 py-2.5"
                >
                  <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--personal-text-secondary)]">
                    <span className="font-semibold text-[var(--personal-text)]">
                      {noteKindLabel(note.kind)}
                    </span>
                    {mark !== null ? (
                      <span className="rounded-[var(--personal-radius-pill)] border border-[var(--personal-border)] px-2 py-0.5 font-medium text-[var(--personal-text)]">
                        {feedbackLabel(mark)}
                      </span>
                    ) : null}
                    {!note.current ? <span>replaced or forgotten since</span> : null}
                  </p>
                  <p className="mt-1 text-[14px] leading-snug break-words text-[var(--personal-text)]">
                    {plainMemoryText(note.snippet)}
                    <span className="mt-1 block text-xs break-words">{note.provenance}</span>
                  </p>
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {/* Traces kept from before the server named it: a note with no other reason matched on words. */}
                    {(note.why.length > 0 ? note.why : [MATCHED_WORDS]).map((reason) => (
                      <li key={reason} className={CHIP}>
                        {reason}
                      </li>
                    ))}
                  </ul>
                  {readOnly || !note.current ? null : (
                    <div
                      className="mt-2 flex flex-wrap gap-2"
                      role="group"
                      aria-label="Change how this memory is used"
                    >
                      {(["outdated", "not_relevant"] as const).map((signal) => (
                        <button
                          key={signal}
                          type="button"
                          disabled={busy}
                          aria-pressed={mark === signal}
                          onClick={() => onMark(note.memoryId, nextFeedback(mark, signal))}
                          className={cn(
                            MARK_BUTTON,
                            mark === signal
                              ? "border-[var(--personal-text)] bg-[var(--personal-fill-muted)] text-[var(--personal-text)]"
                              : "border-[var(--personal-border)] text-[var(--personal-text-secondary)]",
                          )}
                        >
                          {signal === "outdated" ? "Outdated" : "Not relevant"}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {context.leftOut.length > 0 ? (
        <section aria-label="Left out">
          <p className={SECTION_LABEL}>Left out</p>
          <ul className="mt-1 flex flex-col gap-1.5">
            {context.leftOut.map((entry) => (
              <li
                key={entry.memoryId}
                className="text-[13px] leading-snug break-words text-[var(--personal-text-secondary)]"
              >
                <span className="text-[var(--personal-text)]">
                  {plainMemoryText(entry.snippet)}
                </span>
                <span className="block text-[12px] text-[var(--personal-text-tertiary)]">
                  {noteKindLabel(entry.kind)} · {entry.reason}
                  {entry.provenance ? <span className="block">{entry.provenance}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {context.query.terms.length > 0 ? (
        <p className="text-[12px] leading-snug text-[var(--personal-text-tertiary)]">
          {context.query.followUp
            ? "Your message said little, so the chat's topic led the search: "
            : "Searched for: "}
          {context.query.terms.join(", ")}.
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-[13px] text-[var(--personal-error)]">
          {error}
        </p>
      ) : null}

      <p className="text-[12px] leading-snug text-[var(--personal-text-tertiary)]">
        Outdated stops automatic use; Not relevant ranks a note lower. Nothing is deleted. To change
        a rule: tell the bot to change or forget it, or change it on the Memory screen.
      </p>
    </div>
  );
}

/**
 * The tucked-away "Context used" line under the last reply of a turn. Closed
 * until tapped; the turn's memory is fetched only then.
 */
export function ContextUsed({
  environmentId,
  threadId,
  messageId,
  readOnly = false,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  /** The message that started the turn this reply belongs to. */
  messageId: string;
  readOnly?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const turn = usePersonalMemoryTurnContext(environmentId, open ? { threadId, messageId } : null);
  const sendFeedback = useAtomCommand(personalMemoryFeedback);
  const [marks, setMarks] = useState<ReadonlyMap<string, PersonalMemoryFeedbackSignal | null>>(
    new Map(),
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onMark = async (memoryId: string, signal: PersonalMemoryFeedbackSignal | "clear") => {
    if (busyId !== null) return;
    setBusyId(memoryId);
    setError(null);
    const result = await sendFeedback({
      environmentId,
      input: { memoryId: memoryId as never, signal },
    });
    const message = commandFailureMessage(result, "Could not save that mark.");
    setBusyId(null);
    if (message !== null) {
      setError(message);
      return;
    }
    setMarks((current) => new Map(current).set(memoryId, signal === "clear" ? null : signal));
  };

  const context = turn.data;
  return (
    <div data-testid="context-used" className="-mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="-ml-1 flex min-h-9 items-center gap-1 rounded-[var(--personal-radius-button)] px-1 text-[12px] font-medium text-[var(--personal-text-tertiary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] active:opacity-70"
      >
        <span>
          Context used
          {open && context !== null && context !== undefined
            ? ` · ${contextUsedSummary(context)}`
            : ""}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open ? "rotate-180" : "")}
          strokeWidth={2}
        />
      </button>
      <div id={panelId} hidden={!open}>
        {!open ? null : context === null || context === undefined ? (
          <p className="mt-1 text-[13px] leading-snug text-[var(--personal-text-secondary)]">
            {turn.error !== null
              ? turn.error
              : turn.isPending
                ? "Loading…"
                : "No memory was recorded for this turn (none was given, or it is older than 14 days)."}
          </p>
        ) : (
          <ContextUsedView
            context={context}
            marks={marks}
            busyId={busyId}
            onMark={(id, signal) => void onMark(id, signal)}
            readOnly={readOnly}
            error={error}
          />
        )}
      </div>
    </div>
  );
}
