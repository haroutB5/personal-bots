/**
 * Masks saved secrets in provider events. Output arrives in chunks, so each
 * item holds back a tail that could still become a known value, and releases
 * it as one delta when the item ends.
 */
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  secretRedactor as sharedRedactor,
  type SecretRedactor,
  type SecretStream,
} from "../personal/secrets/secretRedaction.ts";

type ProviderEvent = ProviderAdapter.ProviderAdapterV2Event;
type DeltaEvent = Extract<ProviderEvent, { readonly type: "command_output.delta" }>;
type ItemEvent = Extract<ProviderEvent, { readonly type: "turn_item.updated" }>;

interface Held {
  readonly stream: SecretStream;
  /** The newest delta of this item: the event a released tail is dressed as. */
  readonly last: DeltaEvent;
}

const isDelta = (event: ProviderEvent): event is DeltaEvent =>
  event.type === "command_output.delta";

const itemKey = (threadId: string, itemId: string): string => `${threadId}\u0000${itemId}`;
const deltaKey = (event: DeltaEvent): string => itemKey(event.threadId, event.itemId);

const endsEveryStream = (event: ProviderEvent): boolean =>
  event.type === "turn.terminal" ||
  (event.type === "provider_session.updated" &&
    (event.providerSession.status === "stopped" || event.providerSession.status === "error"));

const endsItem = (event: ItemEvent): boolean => !isOrchestrationV2WorkActive(event.turnItem.status);

const itemKeyOf = (event: ItemEvent): string => itemKey(event.turnItem.threadId, event.turnItem.id);

export interface ProviderEventSecretFilter {
  /** The events to publish in place of `event`: usually it alone, masked. May be none or several. */
  readonly process: (event: ProviderEvent) => ReadonlyArray<ProviderEvent>;
  /** Items that are holding a tail right now (tests and diagnostics). */
  readonly holding: () => number;
}

export function makeProviderEventSecretFilter(
  redactor: SecretRedactor = sharedRedactor,
): ProviderEventSecretFilter {
  const held = new Map<string, Held>();

  const releasedAsDelta = (entry: Held, tail: string): ProviderEvent => ({
    ...entry.last,
    chunk: tail,
  });

  /** Releases what streams matching `matches` are holding, as final deltas. */
  const release = (matches: (event: DeltaEvent) => boolean): Array<ProviderEvent> => {
    const out: Array<ProviderEvent> = [];
    for (const [key, entry] of held) {
      if (!matches(entry.last)) continue;
      held.delete(key);
      const tail = entry.stream.flush();
      if (tail.length === 0) continue;
      out.push(releasedAsDelta(entry, tail));
    }
    return out;
  };

  return {
    process: (event) => {
      if (isDelta(event)) {
        if (!redactor.active()) return [event];
        const key = deltaKey(event);
        const entry = held.get(key);
        const stream = entry?.stream ?? redactor.stream();
        const safe = stream.push(event.chunk);
        if (stream.holding()) held.set(key, { stream, last: event });
        else held.delete(key);
        if (safe.length === 0 && event.chunk.length > 0) return [];
        return [{ ...event, chunk: safe }];
      }
      const releases =
        event.type === "turn_item.updated" && endsItem(event)
          ? release((last) => deltaKey(last) === itemKeyOf(event))
          : endsEveryStream(event)
            ? release(() => true)
            : [];
      return [...releases, redactor.redact(event)];
    },
    holding: () => held.size,
  };
}
