import type { OrchestrationMessageContext } from "./composerContext.ts";
import { ComposerContextId } from "./composerContext.ts";
import type { ThreadTurnFollowUp } from "./orchestration.ts";

/**
 * How an owner's message was meant to land on a thread that was already
 * working: a plain send steers into the running turn, "Queue after this turn"
 * waits for it to end.
 *
 * Rides on the sent message's `context` as a forward-compatible record of this
 * kind, like `PERSONAL_REPLY_CONTEXT_KIND` and
 * `PERSONAL_TASK_MESSAGE_CONTEXT_KIND`: no text references it, so
 * `projectComposerContextForProvider` drops it and providers never see it,
 * while the record travels with the message itself. That is what lets the
 * label under the bubble say "Queued" only for a send that really asked to
 * wait, and "Steering" for everything else, after a reload and on the owner's
 * other devices. The turn-start event carries the same choice, but no thread
 * read model exposes it, so the message is where a client can read it back.
 *
 * Only "queue" is written: absent means steer (the contract's own default for
 * `thread.turn.start`), so a plain send stores nothing and every message
 * written before this existed reads back as a steer.
 */
export const PERSONAL_FOLLOW_UP_CONTEXT_KIND = "personal-follow-up";

/** A record is only read back when it is shaped exactly like one of ours. */
function isFollowUpPayload(payload: unknown): payload is { readonly followUp: ThreadTurnFollowUp } {
  if (typeof payload !== "object" || payload === null) return false;
  const followUp = (payload as { readonly followUp?: unknown }).followUp;
  return followUp === "steer" || followUp === "queue";
}

/**
 * The message `context` for a send, with the queue choice added when there is
 * one. `base` is whatever the send already carries (a reply's quote); null is
 * no context at all, which is what a plain steer send keeps.
 */
export function withPersonalFollowUp(
  base: OrchestrationMessageContext | null,
  followUp: ThreadTurnFollowUp | undefined,
): OrchestrationMessageContext | null {
  if (followUp !== "queue") return base;
  return {
    version: 1,
    records: [
      ...(base?.records ?? []),
      {
        version: 1,
        contextId: ComposerContextId.make(PERSONAL_FOLLOW_UP_CONTEXT_KIND),
        label: "Queue after this turn",
        kind: PERSONAL_FOLLOW_UP_CONTEXT_KIND,
        payload: { followUp },
      },
    ],
  };
}

/**
 * The queue choice a message's `context` carries, or null when it carries none
 * (a plain steer, a message from before this existed, or a record that is not
 * shaped like one).
 */
export function readPersonalFollowUp(
  context: { readonly records: ReadonlyArray<object> } | null | undefined,
): ThreadTurnFollowUp | null {
  if (context === null || context === undefined) return null;
  for (const record of context.records) {
    const entry = record as { readonly kind?: unknown; readonly payload?: unknown };
    if (entry.kind !== PERSONAL_FOLLOW_UP_CONTEXT_KIND) continue;
    if (!isFollowUpPayload(entry.payload)) return null;
    return entry.payload.followUp;
  }
  return null;
}
