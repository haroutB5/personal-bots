import type { JSX } from "react";

import { Archive } from "lucide-react";

/**
 * Takes the composer's place in an archived chat or group: the history reads
 * as normal, nothing can be sent, and Unarchive brings the composer back in
 * place. Delete goes through the caller's usual confirm.
 */
export function ArchivedChatBar({
  hint,
  unarchiving,
  deleting = false,
  disabled = false,
  onUnarchive,
  onDelete,
}: {
  /** The muted line after "Archived.". */
  hint: string;
  unarchiving: boolean;
  deleting?: boolean;
  /** Offline: neither action can reach the laptop. */
  disabled?: boolean;
  onUnarchive: () => void;
  onDelete: () => void;
}): JSX.Element {
  const busy = unarchiving || deleting;
  return (
    <div className="personal-column shrink-0 px-4 pb-2">
      <div
        role="status"
        aria-label="Archived chat"
        className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--personal-radius-card)] border border-[var(--personal-border)] bg-[var(--personal-fill-muted)] py-2 pr-2 pl-4"
      >
        <Archive
          aria-hidden="true"
          className="size-5 shrink-0 text-[var(--personal-text-secondary)]"
          strokeWidth={1.75}
        />
        <p className="min-w-0 flex-1 basis-40 text-[15px] leading-5 text-[var(--personal-text)]">
          <span className="font-semibold">Archived.</span>{" "}
          <span className="text-[var(--personal-text-secondary)]">{hint}</span>
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={busy || disabled}
            onClick={onDelete}
            className="flex h-11 shrink-0 items-center rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] bg-[var(--personal-surface)] px-4 text-[15px] font-medium text-[var(--personal-error)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50"
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={onUnarchive}
            className="flex h-11 shrink-0 items-center rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-4 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-50"
          >
            {unarchiving ? "Unarchiving…" : "Unarchive"}
          </button>
        </div>
      </div>
    </div>
  );
}
