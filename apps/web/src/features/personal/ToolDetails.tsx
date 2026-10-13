import type { JSX } from "react";
import { memo, useState } from "react";

import { ChevronDown, CircleAlert, CircleCheck, Wrench } from "lucide-react";

import { workEntryDisplayLabel } from "~/components/chat/MessagesTimeline.logic";
import { cn } from "~/lib/utils";
import type { WorkLogEntry } from "~/session-logic";

/**
 * Tool and work activity for one stretch of a turn: the steps button under a
 * full-width reply (SPEC 2.8, 44 tall, radius 12, tool icon, **N steps** · the
 * first step, chevron), opening the work log. The log's rows are mounted only
 * while it is open, so a long tool-heavy turn costs one button until someone
 * asks for the detail. Every row is a real work-log entry; the live marker
 * only shows while the turn is still running.
 */
interface ToolDetailsProps {
  entries: ReadonlyArray<WorkLogEntry>;
  live: boolean;
  workspaceRoot: string | undefined;
}

// The conversation builder allocates a fresh `entries` array on every
// rebuild, so identity never matches; compare the entries themselves (their
// objects are stable between rebuilds unless a step actually changed).
function sameToolDetails(previous: ToolDetailsProps, next: ToolDetailsProps): boolean {
  if (previous.live !== next.live || previous.workspaceRoot !== next.workspaceRoot) return false;
  if (previous.entries === next.entries) return true;
  if (previous.entries.length !== next.entries.length) return false;
  for (let index = 0; index < next.entries.length; index += 1) {
    if (previous.entries[index] !== next.entries[index]) return false;
  }
  return true;
}

export const ToolDetails = memo(function ToolDetails({
  entries,
  live,
  workspaceRoot,
}: ToolDetailsProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const failures = entries.filter((entry) => entry.tone === "error").length;
  const count = `${entries.length} ${entries.length === 1 ? "step" : "steps"}`;
  const first = entries[0];
  const summary = first === undefined ? null : workEntryDisplayLabel(first, workspaceRoot);
  return (
    <details
      data-testid="tool-details"
      className="group max-w-full"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex h-11 max-w-full cursor-pointer list-none items-center gap-2 rounded-[var(--personal-radius-control)] bg-[var(--personal-surface)] px-3 text-[15px] leading-5 text-[var(--personal-text-secondary)] [box-shadow:inset_0_0_0_1px_var(--personal-border)] outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] [&::-webkit-details-marker]:hidden">
        {live ? (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-[var(--personal-live)]"
          />
        ) : (
          <Wrench aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
        )}
        <span className="min-w-0 truncate">
          <b className="font-semibold text-[var(--personal-text)]">
            {live ? `Working · ${count}` : count}
          </b>
          {failures > 0 ? (
            <span> · {failures} failed</span>
          ) : summary === null ? null : (
            <span> · {summary}</span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
          strokeWidth={1.75}
        />
      </summary>
      {open ? (
        <ol className="mt-1 flex flex-col gap-2 rounded-[var(--personal-radius-control)] px-3 py-2.5 [box-shadow:inset_0_0_0_1px_var(--personal-border)]">
          {entries.map((entry) => {
            const label = workEntryDisplayLabel(entry, workspaceRoot);
            const Icon =
              entry.tone === "error" ? CircleAlert : entry.tone === "tool" ? Wrench : CircleCheck;
            return (
              <li key={entry.id} className="flex min-w-0 items-start gap-2 text-sm">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    entry.tone === "error"
                      ? "text-[var(--personal-error)]"
                      : "text-[var(--personal-text-tertiary)]",
                  )}
                  strokeWidth={1.75}
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-[var(--personal-text)]/80">{label}</span>
                  {entry.detail && entry.detail.trim() !== label.trim() ? (
                    <span className="mt-0.5 block line-clamp-3 break-words text-[13px] text-[var(--personal-text-secondary)]">
                      {entry.detail}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </details>
  );
}, sameToolDetails);
