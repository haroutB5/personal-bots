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
 * model and effort ("Opus 5.5 · H"). The status comes first and keeps the
 * room it needs; the model label is the optional part. Both sit on one line
 * that is exactly one row tall, so when they do not fit together the model
 * label wraps to a second row that the line clips: it goes whole, never cut
 * to "Sonnet 5.…" at 390 px. A status too long for the line alone ends in an
 * ellipsis. The provider name is not shown: the model label names the runtime.
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
        className="flex h-[18px] min-w-0 flex-1 flex-wrap items-center gap-x-1.5 overflow-hidden"
      >
        <span className="max-w-full min-w-0 truncate whitespace-nowrap">{status}</span>
        {modelLabel !== null ? (
          <span data-testid="chat-model-label" className="shrink-0 whitespace-nowrap">
            <span aria-hidden="true">· </span>
            {modelLabel}
            {modelNote !== null ? <span className="sr-only"> ({modelNote})</span> : null}
          </span>
        ) : null}
      </span>
    </p>
  );
}
