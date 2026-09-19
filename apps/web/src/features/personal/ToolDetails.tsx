import type { JSX } from "react";
import { memo } from "react";

import { ChevronRight, CircleAlert, CircleCheck, Wrench } from "lucide-react";

import { workEntryDisplayLabel } from "~/components/chat/MessagesTimeline.logic";
import type { WorkLogEntry } from "~/session-logic";

function summaryLabel(entries: ReadonlyArray<WorkLogEntry>, live: boolean): string {
  const failures = entries.filter((entry) => entry.tone === "error").length;
  const count = `${entries.length} ${entries.length === 1 ? "step" : "steps"}`;
  if (live) return `Working · ${count}`;
  return failures > 0 ? `${count} · ${failures} failed` : count;
}

/**
 * Tool and work activity for one stretch of a turn, collapsed by default
 * (ui-spec: activity lives behind a "details" disclosure). Every row is a real
 * work-log entry; the live marker only shows while the turn is still running.
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
  return (
    <details className="group max-w-[90%] rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-surface)]">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3.5 text-sm text-[var(--personal-text-secondary)] outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 transition-transform group-open:rotate-90"
          strokeWidth={1.75}
        />
        {live ? (
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-[var(--personal-live)]"
          />
        ) : null}
        <span className="min-w-0 truncate">{summaryLabel(entries, live)}</span>
      </summary>
      <ol className="flex flex-col gap-2 px-3.5 pb-3">
        {entries.map((entry) => {
          const label = workEntryDisplayLabel(entry, workspaceRoot);
          const Icon =
            entry.tone === "error" ? CircleAlert : entry.tone === "tool" ? Wrench : CircleCheck;
          return (
            <li key={entry.id} className="flex min-w-0 items-start gap-2 text-sm">
              <Icon
                aria-hidden="true"
                className={
                  entry.tone === "error"
                    ? "mt-0.5 size-4 shrink-0 text-[var(--personal-error)]"
                    : "mt-0.5 size-4 shrink-0 text-[var(--personal-text-tertiary)]"
                }
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
    </details>
  );
}, sameToolDetails);
