import { useCallback, useEffect, useMemo } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, PersonalReplyQuote, ThreadId } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";

import {
  type OutboxEntry,
  type OutboxRow,
  removeOutboxEntry,
  retryOutboxEntry,
  useOutboxRows,
} from "./outbox";
import { deleteOutboxBlobs } from "./outboxBlobs";

/** Drops a queued message and the bytes kept for it. */
export function discardQueuedMessage(id: string): OutboxEntry | null {
  const removed = removeOutboxEntry(id);
  if (removed !== null) deleteOutboxBlobs(id);
  return removed;
}

/**
 * The send queue as one chat shows it: the messages still on this device
 * (typed while the laptop was away) and what Cancel, Edit and Retry do to
 * them. A queued message whose id already shows in the transcript did land
 * (its reply was lost), so it is dropped from the queue instead of drawn twice.
 */
export function useQueuedMessages(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly messages: ReadonlyArray<{ readonly id: string }>;
  /** Edit puts the quote the message replied to back in the composer. */
  readonly onRestoreReply?: ((quote: PersonalReplyQuote) => void) | undefined;
}): {
  readonly rows: ReadonlyArray<OutboxRow>;
  readonly onCancel: (id: string) => void;
  readonly onEdit: (entry: OutboxEntry) => void;
  readonly onRetry: (id: string) => void;
} {
  const { environmentId, threadId, messages, onRestoreReply } = input;
  const all = useOutboxRows(threadId === null ? null : String(threadId));
  const echoed = useMemo(
    () => new Set(messages.map((message) => message.id as string)),
    [messages],
  );
  const rows = useMemo(() => all.filter((row) => !echoed.has(row.entry.id)), [all, echoed]);

  useEffect(() => {
    for (const row of all) {
      if (echoed.has(row.entry.id) && row.state !== "sending") discardQueuedMessage(row.entry.id);
    }
  }, [all, echoed]);

  const onEdit = useCallback(
    (entry: OutboxEntry) => {
      if (environmentId === null || threadId === null) return;
      if (discardQueuedMessage(entry.id) === null) return;
      const store = useComposerDraftStore.getState();
      const ref = scopeThreadRef(environmentId, threadId);
      const typed = store.getComposerDraft(ref)?.prompt ?? "";
      store.setPrompt(ref, typed.trim().length === 0 ? entry.text : `${entry.text}\n${typed}`);
      if (entry.replyTo !== null) onRestoreReply?.(entry.replyTo);
    },
    [environmentId, onRestoreReply, threadId],
  );

  return {
    rows,
    onCancel: (id) => void discardQueuedMessage(id),
    onEdit,
    onRetry: retryOutboxEntry,
  };
}
