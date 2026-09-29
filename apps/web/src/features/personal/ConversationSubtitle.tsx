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
 * model and effort ("Opus 5.5 · H"). The status never truncates, so a long
 * "Waiting on Planner" stays readable; only the model label runs out at the
 * edge. The provider name is not shown: the model label names the runtime.
 */
export function ConversationSubtitle({
  state,
  modelLabel,
  status,
}: {
  state: ConversationState;
  modelLabel: string | null;
  status: string;
}): JSX.Element {
  return (
    <p className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[13px] leading-[18px] text-[var(--personal-text-secondary)]">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state])} />
      <span className="shrink-0 whitespace-nowrap">{status}</span>
      {modelLabel !== null ? (
        <span data-testid="chat-model-label" className="min-w-0 truncate whitespace-nowrap">
          <span aria-hidden="true">· </span>
          {modelLabel}
        </span>
      ) : null}
    </p>
  );
}
