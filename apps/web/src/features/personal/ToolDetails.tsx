import type { JSX } from "react";
import { memo } from "react";

import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Eye,
  Globe,
  Pencil,
  Terminal,
  Wrench,
} from "lucide-react";

import { workEntryDisplayLabel } from "~/components/chat/MessagesTimeline.logic";
import type { WorkLogEntry } from "~/session-logic";

import { toolDetailsSummary } from "./toolDetailsModel";

/**
 * Tool and work activity for one stretch of a turn, in the compact T3 mobile
 * work-log shape Harout approved on 23 Oct: a single 32px summary line (no
 * card), related calls folded behind it, a red failed count on that line, and
 * the current action in place of the count while the turn runs.
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

function SummaryIcon({ entries }: { readonly entries: ReadonlyArray<WorkLogEntry> }): JSX.Element {
  const first = entries[0];
  if (first === undefined) return <Wrench aria-hidden="true" className="size-3.5 shrink-0" />;
  if (first.tone === "error") {
    return <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />;
  }
  const label = first.label.trim().toLowerCase();
  if (first.command !== undefined || first.rawCommand !== undefined || label.startsWith("ran ")) {
    return <Terminal aria-hidden="true" className="size-3.5 shrink-0" />;
  }
  if (first.requestKind === "file-read" || label.startsWith("read ")) {
    return <Eye aria-hidden="true" className="size-3.5 shrink-0" />;
  }
  if ((first.changedFiles?.length ?? 0) > 0 || label.startsWith("edited ")) {
    return <Pencil aria-hidden="true" className="size-3.5 shrink-0" />;
  }
  if (first.toolSurface === "browser") {
    return <Globe aria-hidden="true" className="size-3.5 shrink-0" />;
  }
  return <Wrench aria-hidden="true" className="size-3.5 shrink-0" />;
}

export const ToolDetails = memo(function ToolDetails({
  entries,
  live,
  workspaceRoot,
}: ToolDetailsProps): JSX.Element {
  const summary = toolDetailsSummary(entries, live, workspaceRoot);
  const shown = summary.liveLabel ?? summary.label;
  return (
    <details className="group w-full">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-0.5 text-sm text-[var(--personal-text-secondary)] outline-none select-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-[var(--personal-text-tertiary)] transition-transform group-open:rotate-90"
          strokeWidth={2}
        />
        {live ? (
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--personal-live)]"
          />
        ) : null}
        <SummaryIcon entries={entries} />
        <span
          className={
            live ? "min-w-0 flex-1 truncate text-[var(--personal-text)]" : "min-w-0 flex-1 truncate"
          }
        >
          {shown}
        </span>
        {summary.failures > 0 ? (
          <span className="shrink-0 text-[11px] text-[var(--personal-error)]">
            {summary.failures} failed
          </span>
        ) : null}
        {live ? (
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--personal-text-tertiary)]">
            {summary.count} {summary.count === 1 ? "step" : "steps"}
          </span>
        ) : null}
      </summary>
      <ol className="ml-[18px] flex flex-col border-l border-[var(--personal-border)] pl-2.5">
        {entries.map((entry) => {
          const label = workEntryDisplayLabel(entry, workspaceRoot);
          const failed = entry.tone === "error";
          const Icon = failed ? CircleAlert : entry.tone === "tool" ? Wrench : CircleCheck;
          const detail =
            entry.detail && entry.detail.trim() !== label.trim() ? entry.detail.trim() : null;
          return (
            <li
              key={entry.id}
              className="flex min-h-[30px] min-w-0 items-start gap-1.5 py-1 text-[13px]"
            >
              <Icon
                aria-hidden="true"
                className={
                  failed
                    ? "mt-0.5 size-3.5 shrink-0 text-[var(--personal-error)]"
                    : "mt-0.5 size-3.5 shrink-0 text-[var(--personal-text-tertiary)]"
                }
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={
                    failed
                      ? "block truncate text-[var(--personal-error)]"
                      : "block truncate text-[var(--personal-text)]/80"
                  }
                >
                  {label}
                </span>
                {detail ? (
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--personal-text-tertiary)]">
                    {detail}
                  </span>
                ) : null}
              </span>
              {failed ? (
                <span
                  aria-label="Tool call failed"
                  className="mt-0.5 shrink-0 text-[11px] text-[var(--personal-error)]"
                >
                  ✕
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </details>
  );
}, sameToolDetails);
