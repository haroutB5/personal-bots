import type { JSX } from "react";

import { cn } from "~/lib/utils";

import type { ConversationState } from "./conversationModel";

const STATE_DOT: Record<ConversationState, string> = {
  idle: "bg-[var(--personal-text-tertiary)]",
  needs_help: "bg-[var(--personal-review)]",
  working: "bg-[var(--personal-live)]",
  waiting: "bg-[var(--personal-review)]",
  // Waiting on a task: not working itself, not needing the user. A hollow ring, never the live dot.
  delegating: "border border-[var(--personal-text-tertiary)]",
  rate_limited: "bg-[var(--personal-review)]",
  retrying: "bg-[var(--personal-review)]",
  error: "bg-[var(--personal-error)]",
};

/**
 * Header subtitle: the state dot and what the bot is doing, then the bot's
 * model and effort ("Opus 5.5 · H"). The status comes first and keeps the room
 * it needs: it is the primary line, so the model label is the part that gives
 * way. A long model label used to squeeze the status down to "Id…" at 390 px
 * (1.66.44 QA), so the status never shrinks for it — the model label shrinks
 * first and ends in an ellipsis, and a status too wide for the line on its own
 * is the only thing that gets cut. The model label keeps a 4.5rem floor so the
 * model's own name stays readable; in the header variant where the bot name
 * shares the row, the name gives way for that floor. Both sit on one 18px row.
 * The provider name is not shown: the model label names the runtime.
 */
export function ConversationSubtitle({
  state,
  modelLabel,
  modelNote = null,
  status,
}: {
  state: ConversationState;
  modelLabel: string | null;
  /** Why the model is the fallback ("on fallback until about 14:30 ..."), read out after the label. */
  modelNote?: string | null;
  status: string;
}): JSX.Element {
  return (
    <p className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state])} />
      <span
        data-testid="chat-status-line"
        className="flex h-[18px] min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
      >
        <span className="max-w-full shrink-0 truncate whitespace-nowrap">{status}</span>
        {modelLabel !== null ? (
          <span
            data-testid="chat-model-label"
            // The floor keeps the model's own name readable ("Sonnet 5.5") in the
            // header variant where the bot name shares the row; without it the
            // label collapses to "So…" at 390 px (1.66.44 QA, P1). The name group
            // yields first for that floor (ConversationHeaderLine).
            className="min-w-[4.5rem] shrink-[100] truncate whitespace-nowrap"
          >
            <span aria-hidden="true">· </span>
            {modelLabel}
            {modelNote !== null ? <span className="sr-only"> ({modelNote})</span> : null}
          </span>
        ) : null}
      </span>
    </p>
  );
}
