import type { JSX } from "react";

/**
 * The working chat's latest progress note (`deriveLatestProgressNote`): one
 * muted, single line directly under the header, where the "Working" status
 * is. Nothing renders without a note, so an idle chat is unchanged. Not a live
 * region: it changes every few seconds and would drown a screen reader.
 */
export function ProgressNoteLine({ note }: { note: string | null }): JSX.Element | null {
  if (note === null) return null;
  return (
    <p
      data-testid="progress-note"
      className="personal-column shrink-0 truncate px-4 pb-1 text-[13px] leading-5 text-[var(--personal-text-tertiary)]"
    >
      {note}
    </p>
  );
}
