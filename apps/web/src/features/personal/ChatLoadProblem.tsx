import type { JSX, ReactNode } from "react";

import type { ThreadLoadProblem } from "./threadLoadProblem";

/** The way out of a chat that won't load: a 44 px secondary button. */
export const CHAT_PROBLEM_BUTTON =
  "flex h-11 items-center justify-center rounded-[var(--personal-radius-button)] border border-[var(--personal-border)] px-4 text-[15px] font-semibold text-[var(--personal-text)] outline-none active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]";

/**
 * What a chat or group screen shows in place of "Loading" once loading has
 * failed: "missing" (deleted, or a link to something that never existed) gets
 * only the way back; any other error also gets Retry.
 */
export function ChatLoadProblem({
  problem,
  missingText,
  errorText,
  back,
  onRetry,
}: {
  readonly problem: ThreadLoadProblem;
  readonly missingText: string;
  readonly errorText: string;
  /** A link styled with CHAT_PROBLEM_BUTTON. */
  readonly back: ReactNode;
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <div role="alert" className="flex flex-col items-center gap-4">
      <p className="text-[15px] text-[var(--personal-text)]">
        {problem.kind === "missing" ? missingText : errorText}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {problem.kind === "error" ? (
          <button
            type="button"
            onClick={onRetry}
            className="flex h-11 items-center justify-center rounded-[var(--personal-radius-button)] bg-[var(--personal-primary)] px-5 text-[15px] font-semibold text-[var(--personal-primary-text)] outline-none active:opacity-70 focus-visible:ring-2 focus-visible:ring-[var(--personal-text)]"
          >
            Retry
          </button>
        ) : null}
        {back}
      </div>
    </div>
  );
}
