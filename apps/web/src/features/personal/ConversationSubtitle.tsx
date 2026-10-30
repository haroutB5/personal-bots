import type { JSX } from "react";

import { cn } from "~/lib/utils";

import { splitModelMarker } from "./botModelLabel";
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
 * With a marker the model name is what gives way, so "peak" or "sched" is the
 * last thing cut; the bot's name never shrinks for either.
 *
 * Under 380px (a 360px phone has about 170px for this line beside the back
 * button, the avatar and the chips) the line is 12px and an idle bot drops the
 * word "Idle" for good, keeping the dot and the whole model label: at 360 it
 * used to shrink to "Idle ·" with the model gone. A busy or broken status is
 * still written out.
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
  const split =
    modelNote !== null && modelLabel !== null
      ? splitModelMarker(modelLabel)
      : { base: modelLabel ?? "", marker: null };
  const dropIdleWord =
    state === "idle" &&
    showsMarker &&
    (status === CONVERSATION_STATE_LABEL.idle || status.trim() === "");
  // Idle with a model to show: on a narrow phone the dot says it and the room goes to the model.
  const idleWordYieldsWhenNarrow =
    !dropIdleWord &&
    state === "idle" &&
    modelLabel !== null &&
    (status === CONVERSATION_STATE_LABEL.idle || status.trim() === "");
  return (
    <p
      className={cn(
        "flex min-w-0 items-center overflow-hidden leading-[18px] text-[var(--personal-text-secondary)]",
        // The dropped word's room goes to the marker: the dot sits a little
        // closer and the label a point smaller, so more of "Sonnet 5.5 · H ·
        // peak" fits at 390 px beside the name and two chat chips.
        dropIdleWord ? "-ml-0.5 gap-1 text-[12px]" : "gap-1.5 text-[13px] max-[380px]:text-[12px]",
      )}
    >
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
          <span
            className={cn(
              "max-w-full shrink-0 truncate whitespace-nowrap",
              idleWordYieldsWhenNarrow && "max-[380px]:sr-only",
            )}
          >
            {status}
          </span>
        )}
        {modelLabel !== null ? (
          <span
            data-testid="chat-model-label"
            className={cn(
              "min-w-0 shrink-[100] truncate whitespace-nowrap",
              // With a marker the model name gives way and the marker stays.
              split.marker !== null && "flex",
            )}
          >
            {dropIdleWord ? null : (
              <span aria-hidden="true" className={cn(idleWordYieldsWhenNarrow && "max-[380px]:hidden")}>
                ·{" "}
              </span>
            )}
            {split.marker !== null ? (
              <>
                <span className="min-w-0 truncate">{split.base}</span>
                <span data-testid="chat-model-marker" className="shrink-0 whitespace-pre">
                  {` · ${split.marker}`}
                </span>
              </>
            ) : (
              modelLabel
            )}
            {modelNote !== null ? <span className="sr-only"> ({modelNote})</span> : null}
          </span>
        ) : null}
      </span>
    </p>
  );
}
