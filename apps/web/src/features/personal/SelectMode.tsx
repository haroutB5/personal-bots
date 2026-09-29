import type { JSX, ReactNode } from "react";
import { useEffect, useState } from "react";

import { Check } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * The select mode a bot's chat list introduced, shared by every list that
 * has it (chats, Files, Memory) so the bars, labels and checks look and
 * behave the same everywhere.
 */

export const SELECT_TEXT_BUTTON =
  "flex h-11 shrink-0 items-center rounded-[var(--personal-radius-button)] px-2 text-[15px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[var(--personal-text)] disabled:opacity-40";

// A hold on a row enters select mode, so it must not also start iOS text
// selection on the title or its link preview.
export const NO_TOUCH_SELECT = "select-none [-webkit-touch-callout:none]";

/** The round check at the left of a row in select mode. */
export function SelectCheck({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[22px] shrink-0 items-center justify-center rounded-full border-2",
        checked
          ? "border-[var(--personal-primary)] bg-[var(--personal-primary)] text-[var(--personal-primary-text)]"
          : "border-[var(--personal-text-tertiary)]",
      )}
    >
      {checked ? <Check className="size-3.5" strokeWidth={3} /> : null}
    </span>
  );
}

/** Cancel, "N selected" and Select all / Deselect all, in place of the screen's own header. */
export function SelectModeHeader({
  label,
  everySelected,
  canSelectAll,
  onCancel,
  onToggleAll,
}: {
  label: string;
  everySelected: boolean;
  canSelectAll: boolean;
  onCancel: () => void;
  onToggleAll: () => void;
}): JSX.Element {
  return (
    <header className="flex h-16 items-center gap-2">
      <button
        type="button"
        onClick={onCancel}
        className={cn("-ml-2", SELECT_TEXT_BUTTON, "font-normal text-[var(--personal-text)]")}
      >
        Cancel
      </button>
      <h1
        aria-live="polite"
        className="min-w-0 flex-1 truncate text-center text-[17px] font-bold text-[var(--personal-text)] tabular-nums"
      >
        {label}
      </h1>
      <button
        type="button"
        onClick={onToggleAll}
        disabled={!canSelectAll}
        className={cn("-mr-2", SELECT_TEXT_BUTTON, "text-[var(--personal-text)]")}
      >
        {everySelected ? "Deselect all" : "Select all"}
      </button>
    </header>
  );
}

/** The action bar, pinned to the bottom of the screen above the home indicator. */
export function SelectModeActions({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      className="sticky bottom-0 -mx-5 mt-auto flex items-center justify-between border-t border-[var(--personal-border)] bg-[var(--personal-bg)] px-5 pt-2"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 8px)" }}
    >
      {children}
    </div>
  );
}

/** The bar's Delete, at its right end. */
export function SelectModeDeleteButton({
  disabled,
  busy,
  onClick,
}: {
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy}
      className={cn("-mr-2 ml-auto", SELECT_TEXT_BUTTON, "text-[var(--personal-error)]")}
    >
      Delete
    </button>
  );
}

export interface BulkNotice {
  readonly text: string;
  readonly failed: boolean;
}

/** The one line a bulk action leaves: a status, or an alert when some rows failed. */
export function BulkNoticeLine({ notice }: { notice: BulkNotice | null }): JSX.Element | null {
  if (notice === null) return null;
  return (
    <p
      role={notice.failed ? "alert" : "status"}
      className={cn(
        "mt-3 text-center text-sm",
        notice.failed ? "text-[var(--personal-error)]" : "text-[var(--personal-text-secondary)]",
      )}
    >
      {notice.text}
    </p>
  );
}

/** A plain result fades after a while; one with failures stays until the next action. */
export function useBulkNotice(): readonly [BulkNotice | null, (next: BulkNotice | null) => void] {
  const [notice, setNotice] = useState<BulkNotice | null>(null);
  useEffect(() => {
    if (notice === null || notice.failed) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}

/** Escape leaves select mode, as Cancel does. */
export function useEscapeToExit(active: boolean, exit: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") exit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, exit]);
}
