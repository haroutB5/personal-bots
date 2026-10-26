import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type { MessageId, PersonalThreadFullTextInput, ScopedThreadRef } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

/**
 * Chat opens send finished reasoning and long tool commands as previews
 * (threadTextPreviews.ts on the server, kill switch `text-previews`). The
 * classic timeline shows that text only when a row is expanded, and asks for
 * the whole text here then. The Bots app never needs it.
 */
export const personalThreadFullText = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "personal-bots:thread-full-text",
  tag: WS_METHODS.personalBotsThreadFullText,
  staleTimeMs: Number.POSITIVE_INFINITY,
  idleTtlMs: 5 * 60_000,
});

export type ThreadFullTextTarget = { readonly messageId: string } | { readonly activityId: string };

export interface ThreadFullTextView {
  /** The whole message text, or the activity's whole payload; null until loaded. */
  readonly text: string | null;
  readonly payload: unknown;
  readonly pending: boolean;
}

const NOTHING: ThreadFullTextView = { text: null, payload: null, pending: false };

/** Loads the whole text behind one preview while `target` is non-null. */
export function useThreadFullText(
  threadRef: ScopedThreadRef | null,
  target: ThreadFullTextTarget | null,
): ThreadFullTextView {
  const input: PersonalThreadFullTextInput | null =
    threadRef === null || target === null
      ? null
      : {
          threadId: threadRef.threadId,
          ...("messageId" in target
            ? { messageIds: [target.messageId as MessageId] }
            : { activityIds: [target.activityId] }),
        };
  const query = useEnvironmentQuery(
    input === null || threadRef === null
      ? null
      : personalThreadFullText({ environmentId: threadRef.environmentId, input }),
  );
  if (input === null || target === null) return NOTHING;
  const data = query.data;
  if (data === null) return { ...NOTHING, pending: query.error === null };
  if ("messageId" in target) {
    const found = data.messages.find((entry) => entry.messageId === target.messageId);
    return { text: found?.text ?? null, payload: null, pending: false };
  }
  const found = data.activities.find((entry) => entry.activityId === target.activityId);
  return { text: null, payload: found?.payload ?? null, pending: false };
}
