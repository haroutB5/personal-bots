/**
 * Keeps saved secret values out of everything a provider session says: reply
 * text, command output, tool results, plans, errors and activity detail.
 *
 * Every runtime event passes through `process` on its way onto the bus
 * (`ProviderService.publishRuntimeEvent`), which is where the chat, the task
 * results, the activity feed and the canonical event log all read from.
 *
 * Streamed text arrives in pieces, and a value split across two pieces would
 * get past a per-piece mask. So each stream (one per thread, turn, item and
 * stream kind) holds back only the tail that could still grow into a known
 * value, and a boundary event (an item or turn ending, a session closing)
 * releases whatever is held as one last delta ahead of it.
 */
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import {
  secretRedactor as sharedRedactor,
  type SecretRedactor,
  type SecretStream,
} from "../personal/secrets/secretRedaction.ts";

interface Held {
  readonly stream: SecretStream;
  /** The newest delta event of this stream: the one a released tail is dressed as. */
  readonly last: ProviderRuntimeEvent;
}

type DeltaEvent = Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;
type ProposedDeltaEvent = Extract<ProviderRuntimeEvent, { readonly type: "turn.proposed.delta" }>;

const isDelta = (event: ProviderRuntimeEvent): event is DeltaEvent | ProposedDeltaEvent =>
  event.type === "content.delta" || event.type === "turn.proposed.delta";

const streamKey = (event: DeltaEvent | ProposedDeltaEvent): string => {
  const payload = event.payload as {
    readonly streamKind?: string;
    readonly contentIndex?: number;
    readonly summaryIndex?: number;
  };
  return [
    event.threadId,
    event.turnId ?? "",
    event.itemId ?? "",
    event.type,
    payload.streamKind ?? "",
    payload.contentIndex ?? "",
    payload.summaryIndex ?? "",
  ].join("|");
};

/** Events that end a stream: what is held for it is released ahead of them. */
const endsStreams = (event: ProviderRuntimeEvent): boolean =>
  event.type === "item.completed" ||
  event.type === "turn.completed" ||
  event.type === "turn.aborted" ||
  event.type === "turn.proposed.completed" ||
  event.type === "session.exited" ||
  event.type === "runtime.error" ||
  event.type === "thread.state.changed";

export interface ProviderEventSecretFilter {
  /** The events to publish in place of `event`: usually it alone, masked. May be none or several. */
  readonly process: (event: ProviderRuntimeEvent) => ReadonlyArray<ProviderRuntimeEvent>;
  /** Streams that are holding a tail right now (tests and diagnostics). */
  readonly holding: () => number;
}

export function makeProviderEventSecretFilter(
  redactor: SecretRedactor = sharedRedactor,
): ProviderEventSecretFilter {
  const held = new Map<string, Held>();

  const withDelta = (event: DeltaEvent | ProposedDeltaEvent, delta: string): ProviderRuntimeEvent =>
    ({
      ...event,
      payload: { ...event.payload, delta },
    }) as ProviderRuntimeEvent;

  /** Releases what streams matching `matches` are holding, as final deltas. */
  const release = (
    matches: (event: ProviderRuntimeEvent) => boolean,
  ): Array<ProviderRuntimeEvent> => {
    const out: Array<ProviderRuntimeEvent> = [];
    for (const [key, entry] of held) {
      if (!matches(entry.last)) continue;
      held.delete(key);
      const tail = entry.stream.flush();
      if (tail.length === 0) continue;
      const last = entry.last as DeltaEvent | ProposedDeltaEvent;
      out.push({
        ...withDelta(last, tail),
        eventId: `${last.eventId}:secret-tail` as ProviderRuntimeEvent["eventId"],
      } as ProviderRuntimeEvent);
    }
    return out;
  };

  return {
    process: (event) => {
      if (!redactor.active()) {
        // Nothing to mask, but a stream may still hold a tail from before a key was removed.
        return held.size === 0 || !endsStreams(event)
          ? [event]
          : [...release((entry) => entry.threadId === event.threadId), event];
      }
      if (isDelta(event)) {
        const key = streamKey(event);
        const entry = held.get(key);
        const stream = entry?.stream ?? redactor.stream();
        const delta = (event.payload as { readonly delta: string }).delta;
        const safe = stream.push(delta);
        if (stream.holding()) held.set(key, { stream, last: event });
        else held.delete(key);
        if (safe.length === 0 && delta.length > 0) return [];
        // The raw provider message carries the same text unmasked and nothing reads it.
        const { raw: _raw, ...rest } = withDelta(event, safe) as ProviderRuntimeEvent & {
          readonly raw?: unknown;
        };
        return [rest as ProviderRuntimeEvent];
      }
      const before = endsStreams(event)
        ? release((entry) => entry.threadId === event.threadId)
        : [];
      return [...before, redactor.redact(event)];
    },
    holding: () => held.size,
  };
}
