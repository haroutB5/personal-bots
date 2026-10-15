import type { JSX } from "react";

import { cn } from "~/lib/utils";

import { CONVERSATION_STATE_LABEL, type ConversationState } from "./conversationModel";

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
 * is the only thing that gets cut. Both sit on one 18px row. The provider name
 * is not shown: the model label names the runtime.
 *
 * While a marker rides the model label (sched, peak, fallback) an idle bot
 * drops the word "Idle" and keeps the state dot, so the marker fits at 390 px
 * beside two chat chips (Harout, 15 Oct). A busy, waiting or broken status is
 * still spoken out loud; the dropped word stays in the line for screen readers.
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
  const showsMarker = modelNote !== null && modelLabel !== null;
  const dropIdleWord =
    state === "idle" &&
    showsMarker &&
    (status === CONVERSATION_STATE_LABEL.idle || status.trim() === "");
  return (
    <p className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state])} />
      <span
        data-testid="chat-status-line"
        className="flex h-[18px] min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
      >
        {dropIdleWord ? (
          status.trim() === "" ? null : (
            <span className="sr-only">{status}</span>
          )
        ) : (
          <span className="max-w-full shrink-0 truncate whitespace-nowrap">{status}</span>
        )}
        {modelLabel !== null ? (
          <span
            data-testid="chat-model-label"
            className="min-w-0 shrink-[100] truncate whitespace-nowrap"
          >
            {dropIdleWord ? null : <span aria-hidden="true">· </span>}
            {modelLabel}
            {modelNote !== null ? <span className="sr-only"> ({modelNote})</span> : null}
          </span>
        ) : null}
      </span>
    </p>
  );
}
