import type { JSX } from "react";
import { useEffect, useState } from "react";

import { Undo2 } from "lucide-react";

/** How long the toast stays; it waits while the Undo button has focus or a pointer is on it. */
export const TEAM_TOAST_MS = 5_000;

/**
 * "Frontend moved to the Assistant's team.  Undo". Sits just above the tab bar.
 * The sentence is announced by the screen's status region, so the toast is not
 * a second live region; it is a plain group with a real, reachable button.
 */
export function TeamMoveToast({
  text,
  onUndo,
  onDismiss,
}: {
  readonly text: string;
  /** Null once the move has been undone (or there is nothing to undo): the text only. */
  readonly onUndo: (() => void) | null;
  readonly onDismiss: () => void;
}): JSX.Element {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(onDismiss, TEAM_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [held, onDismiss, text]);
  return (
    <div
      role="group"
      aria-label="Move result"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
      className="personal-team-toast pointer-events-none fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+12px)] z-30 flex justify-center px-3 md:bottom-4"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-2 rounded-[14px] bg-[var(--personal-text)] py-1.5 pr-1.5 pl-4 text-[var(--personal-bg)] shadow-[var(--personal-shadow-lift)]">
        <p className="min-w-0 flex-1 text-[15px] leading-5 font-semibold">{text}</p>
        {onUndo === null ? null : (
          <button
            type="button"
            onClick={onUndo}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[15px] font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-[var(--personal-bg)]"
          >
            <Undo2 aria-hidden="true" className="size-4" strokeWidth={2.25} />
            Undo
          </button>
        )}
      </div>
    </div>
  );
}
